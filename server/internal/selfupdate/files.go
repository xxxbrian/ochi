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
	"io"
	"os"
	"path/filepath"

	"ochi/server/internal/i18n"
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
		return i18n.New("update_state_invalid")
	}
	for _, build := range []*binaryBuild{m.disk.Pending, m.disk.Backup} {
		if build != nil && (validateBuild(build.Build) != nil || !sha256Pattern.MatchString(build.SHA256)) {
			return i18n.New("update_state_build_invalid")
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
			m.state.Phase = "failed"
			m.state.setError(i18n.New("update_interrupted"))
		default:
			return i18n.New("update_pending_mismatch")
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
			m.state.Phase = "failed"
			m.state.setError(i18n.New("update_backup_lost"))
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
		return i18n.Wrap("update_backup_failed", err)
	}
	defer os.Remove(oldBinary)
	digest, err := fileSHA256(oldBinary)
	if err != nil {
		return i18n.Wrap("update_checksum_read_failed", err)
	}
	previous := m.disk
	next := diskState{Pending: &build, Backup: &binaryBuild{Build: m.state.Current, SHA256: digest}}
	parkedBackup := ""
	if _, err := os.Stat(m.backupPath()); err == nil {
		parked, err := os.CreateTemp(filepath.Dir(m.targetPath), ".ochi-previous-backup-*")
		if err != nil {
			return i18n.Wrap("update_backup_prepare_failed", err)
		}
		parkedBackup = parked.Name()
		parked.Close()
		defer os.Remove(parkedBackup)
		if err := os.Rename(m.backupPath(), parkedBackup); err != nil {
			return i18n.Wrap("update_backup_preserve_failed", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return i18n.Wrap("update_backup_check_failed", err)
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
			m.state.UnsupportedReasonCode = "update_redeploy_required"
			m.state.UnsupportedReason = i18n.New("update_redeploy_required").Error()
			return i18n.Wrap("update_recovery_failed", errors.Join(cause, recovery))
		}
		return cause
	}
	if err := os.Rename(oldBinary, m.backupPath()); err != nil {
		return restore(i18n.Wrap("update_backup_save_failed", err))
	}
	// Persist the target identity before the atomic executable replacement, so
	// startup can distinguish a completed update from an interrupted preparation.
	if err := m.saveDisk(next); err != nil {
		return restore(i18n.Wrap("update_state_save_failed", err))
	}
	if err := os.Rename(path, m.targetPath); err != nil {
		return restore(i18n.Wrap("update_replace_failed", err))
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
		return "", "", i18n.New("update_package_size_mismatch")
	}
	archive, err := os.CreateTemp(filepath.Dir(m.targetPath), ".ochi-update-*.tar.gz")
	if err != nil {
		return "", "", i18n.Wrap("update_temp_failed", err)
	}
	defer os.Remove(archive.Name())
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(archive, hash, progressWriter{manager: m}), io.LimitReader(response.Body, asset.Size+1))
	closeErr := archive.Close()
	if err != nil {
		return "", "", i18n.New("update_download_interrupted")
	}
	if closeErr != nil {
		return "", "", i18n.Wrap("update_package_save_failed", closeErr)
	}
	if count != asset.Size {
		return "", "", i18n.New("update_package_size_invalid")
	}
	if hex.EncodeToString(hash.Sum(nil)) != asset.SHA256 {
		return "", "", i18n.New("update_package_hash_invalid")
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
		return "", "", i18n.New("update_gzip_invalid")
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	header, err := reader.Next()
	if err != nil || header.Name != "ochi-server" || header.Typeflag != tar.TypeReg || header.Size <= 0 || header.Size > maxBinarySize {
		return "", "", i18n.New("update_archive_invalid")
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
		return path, "", i18n.New("update_extract_failed")
	}
	if _, err = reader.Next(); err != io.EOF {
		return path, "", i18n.New("update_archive_extra")
	}
	var trailing int64
	if trailing, err = io.Copy(io.Discard, io.LimitReader(compressed, (1<<20)+1)); err != nil || trailing > 1<<20 {
		return path, "", i18n.New("update_archive_checksum_failed")
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
		return i18n.New("update_executable_invalid")
	}
	defer file.Close()
	machine := elf.EM_X86_64
	if arch == "arm64" {
		machine = elf.EM_AARCH64
	}
	if file.Class != elf.ELFCLASS64 || file.Data != elf.ELFDATA2LSB || file.Machine != machine || (file.Type != elf.ET_EXEC && file.Type != elf.ET_DYN) {
		return i18n.New("update_architecture_mismatch")
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
		return "", i18n.New("update_file_invalid")
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
		return "", i18n.New("update_file_checksum_failed")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
