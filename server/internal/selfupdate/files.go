package selfupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/elf"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func (m *Manager) backupPath() string { return m.targetPath + ".backup" }
func (m *Manager) statePath() string  { return m.targetPath + ".update.json" }

func (m *Manager) loadDisk() error {
	data, err := os.ReadFile(m.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) > 64<<10 || json.Unmarshal(data, &m.disk) != nil {
		return errors.New("更新状态文件格式无效")
	}
	for _, build := range []*binaryBuild{m.disk.Pending, m.disk.Backup} {
		if build != nil && (validateBuild(build.Build) != nil || !sha256Pattern.MatchString(build.SHA256)) {
			return errors.New("更新状态文件中的构建身份无效")
		}
	}
	if m.disk.Pending != nil {
		digest, err := fileSHA256(m.targetPath)
		if err != nil {
			return err
		}
		switch {
		case m.disk.Pending.Build == m.state.Current && digest == m.disk.Pending.SHA256:
			m.disk.Pending = nil
		case m.disk.Backup != nil && m.disk.Backup.Build == m.state.Current && digest == m.disk.Backup.SHA256:
			// A crash before the final atomic rename leaves the old program intact.
			m.disk.Pending, m.disk.Backup = nil, nil
			m.state.Phase, m.state.Error = "failed", "上次更新在替换程序前中断，当前版本未改变，可以重新检查更新"
		default:
			return errors.New("待重启版本与当前程序不一致，请通过镜像重新部署")
		}
		if err := m.saveDisk(m.disk); err != nil {
			return err
		}
	}
	if m.disk.Backup != nil {
		digest, err := fileSHA256(m.backupPath())
		if err != nil || digest != m.disk.Backup.SHA256 {
			// Replacing a previous backup can be interrupted before new metadata
			// is saved. The running binary is confirmed; discard only stale rollback
			// metadata rather than disabling all future updates.
			m.disk.Backup = nil
			if err := m.saveDisk(m.disk); err != nil {
				return err
			}
			m.state.Phase, m.state.Error = "failed", "当前程序已启动，但程序备份丢失或校验失败，已清除不可用的回退信息，可以重新检查更新"
		}
	}
	return nil
}

func (m *Manager) saveDisk(state diskState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(m.targetPath), ".ochi-update-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), m.statePath())
}

func (m *Manager) install(path string, build binaryBuild) error {
	oldBinary, err := copyBinary(m.targetPath, filepath.Dir(m.targetPath))
	if err != nil {
		return fmt.Errorf("备份当前程序失败：%w", err)
	}
	defer os.Remove(oldBinary)
	digest, err := fileSHA256(oldBinary)
	if err != nil {
		return fmt.Errorf("读取当前程序校验值失败：%w", err)
	}
	previous := m.disk
	next := diskState{Pending: &build, Backup: &binaryBuild{Build: m.state.Current, SHA256: digest}}
	parkedBackup := ""
	if _, err := os.Stat(m.backupPath()); err == nil {
		parked, err := os.CreateTemp(filepath.Dir(m.targetPath), ".ochi-previous-backup-*")
		if err != nil {
			return fmt.Errorf("准备程序备份失败：%w", err)
		}
		parkedBackup = parked.Name()
		parked.Close()
		defer os.Remove(parkedBackup)
		if err := os.Rename(m.backupPath(), parkedBackup); err != nil {
			return fmt.Errorf("保留原程序备份失败：%w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("检查原程序备份失败：%w", err)
	}
	restore := func(cause error) error {
		var recovery error
		if parkedBackup != "" {
			recovery = os.Rename(parkedBackup, m.backupPath())
		} else if err := os.Remove(m.backupPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
			recovery = err
		}
		if err := m.saveDisk(previous); err != nil {
			recovery = errors.Join(recovery, err)
		}
		if recovery != nil {
			m.state.Supported = false
			m.state.UnsupportedReason = "更新失败且状态恢复未完成，请通过镜像重新部署"
			return fmt.Errorf("%w；恢复更新状态失败：%v", cause, recovery)
		}
		return cause
	}
	if err := os.Rename(oldBinary, m.backupPath()); err != nil {
		return restore(fmt.Errorf("保存程序备份失败：%w", err))
	}
	// Persist the target identity before the atomic executable replacement, so
	// startup can distinguish a completed update from an interrupted preparation.
	if err := m.saveDisk(next); err != nil {
		return restore(fmt.Errorf("保存更新状态失败：%w", err))
	}
	if err := os.Rename(path, m.targetPath); err != nil {
		return restore(fmt.Errorf("替换程序失败：%w", err))
	}
	m.disk = next
	return nil
}

func (m *Manager) download(ctx context.Context, asset Asset) (path, digest string, err error) {
	response, err := m.get(ctx, asset.URL)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	if response.ContentLength >= 0 && response.ContentLength != asset.Size {
		return "", "", errors.New("更新程序包大小与清单不符")
	}
	archive, err := os.CreateTemp(filepath.Dir(m.targetPath), ".ochi-update-*.tar.gz")
	if err != nil {
		return "", "", fmt.Errorf("无法创建更新临时文件：%w", err)
	}
	defer os.Remove(archive.Name())
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(archive, hash, progressWriter{manager: m}), io.LimitReader(response.Body, asset.Size+1))
	closeErr := archive.Close()
	if err != nil {
		return "", "", errors.New("更新程序包下载中断")
	}
	if closeErr != nil {
		return "", "", fmt.Errorf("保存更新程序包失败：%w", closeErr)
	}
	if count != asset.Size {
		return "", "", errors.New("更新程序包大小校验失败")
	}
	if hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return "", "", errors.New("更新程序包 SHA-256 校验失败，当前程序未改变")
	}
	return extractBinary(archive.Name(), filepath.Dir(m.targetPath), m.arch)
}

type progressWriter struct{ manager *Manager }

func (p progressWriter) Write(data []byte) (int, error) {
	p.manager.mu.Lock()
	p.manager.state.DownloadedBytes += int64(len(data))
	p.manager.mu.Unlock()
	return len(data), nil
}

func extractBinary(archivePath, directory, arch string) (path, digest string, err error) {
	archive, err := os.Open(archivePath)
	if err != nil {
		return "", "", err
	}
	defer archive.Close()
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return "", "", errors.New("更新程序包不是有效的 gzip 文件")
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	header, err := reader.Next()
	if err != nil || header.Name != "ochi-server" || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > maxBinarySize {
		return "", "", errors.New("更新程序包必须只包含顶层 ochi-server 常规程序文件")
	}
	file, err := os.CreateTemp(directory, ".ochi-binary-*")
	if err != nil {
		return "", "", err
	}
	path = file.Name()
	defer func() {
		file.Close()
		if err != nil {
			os.Remove(path)
		}
	}()
	hash := sha256.New()
	if _, err = io.Copy(io.MultiWriter(file, hash), reader); err != nil {
		return path, "", errors.New("解压更新程序失败")
	}
	if _, err = reader.Next(); err != io.EOF {
		return path, "", errors.New("更新程序包含有额外或损坏的文件")
	}
	var trailing int64
	if trailing, err = io.Copy(io.Discard, io.LimitReader(compressed, (1<<20)+1)); err != nil || trailing > 1<<20 {
		return path, "", errors.New("更新程序包压缩校验失败")
	}
	if err = file.Chmod(0o755); err == nil {
		err = file.Sync()
	}
	if err != nil {
		return path, "", err
	}
	if err = file.Close(); err != nil {
		return path, "", err
	}
	if err = validateBinary(path, arch); err != nil {
		return path, "", err
	}
	return path, hex.EncodeToString(hash.Sum(nil)), nil
}

func validateBinary(path, arch string) error {
	file, err := elf.Open(path)
	if err != nil {
		return errors.New("更新程序不是有效的 Linux 可执行文件")
	}
	defer file.Close()
	machine := elf.EM_X86_64
	if arch == "arm64" {
		machine = elf.EM_AARCH64
	}
	if file.Class != elf.ELFCLASS64 || file.Data != elf.ELFDATA2LSB || file.Machine != machine || (file.Type != elf.ET_EXEC && file.Type != elf.ET_DYN) {
		return errors.New("更新程序的 CPU 架构或可执行格式不匹配")
	}
	return nil
}

func copyBinary(source, directory string) (path string, err error) {
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxBinarySize {
		return "", errors.New("程序文件类型或大小无效")
	}
	output, err := os.CreateTemp(directory, ".ochi-binary-copy-*")
	if err != nil {
		return "", err
	}
	path = output.Name()
	defer func() {
		output.Close()
		if err != nil {
			os.Remove(path)
		}
	}()
	if _, err = io.Copy(output, input); err == nil {
		err = output.Chmod(0o755)
	}
	if err == nil {
		err = output.Sync()
	}
	if err != nil {
		return path, err
	}
	err = output.Close()
	return path, err
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, maxBinarySize+1))
	if err != nil || count > maxBinarySize {
		return "", errors.New("程序文件校验失败")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
