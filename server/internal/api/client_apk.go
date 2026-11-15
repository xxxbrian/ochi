package api

import (
	"archive/zip"
	"encoding/binary"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	androidPackageID       = "co.bojin.ochi"
	androidXMLNamespace    = "http://schemas.android.com/apk/res/android"
	maxAPKVersionNameRunes = 1024
)

var errAPKManifest = errors.New("invalid APK release manifest")

type apkVersion struct {
	name string
	code int64
}

// Read only the compiled manifest's root attributes, not classes or resources.
// Chunk and string layouts follow Android's androidfw/ResourceTypes.h.
func readAPKVersion(path string) (apkVersion, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return apkVersion{}, err
	}
	defer archive.Close()
	var manifest *zip.File
	hasCode := false
	for _, entry := range archive.File {
		if entry.Name == "AndroidManifest.xml" {
			if manifest != nil {
				return apkVersion{}, errAPKManifest
			}
			manifest = entry
		}
		hasCode = hasCode || entry.Name == "classes.dex"
	}
	if manifest == nil || !hasCode || manifest.UncompressedSize64 > 4<<20 {
		return apkVersion{}, errAPKManifest
	}
	reader, err := manifest.Open()
	if err != nil {
		return apkVersion{}, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, (4<<20)+1))
	if err != nil || len(data) > 4<<20 {
		return apkVersion{}, errAPKManifest
	}
	return readManifestVersion(data)
}

func readManifestVersion(data []byte) (apkVersion, error) {
	if len(data) < 8 || binary.LittleEndian.Uint16(data) != 3 ||
		uint64(binary.LittleEndian.Uint32(data[4:])) != uint64(len(data)) {
		return apkVersion{}, errAPKManifest
	}
	start := int(binary.LittleEndian.Uint16(data[2:]))
	if start < 8 {
		return apkVersion{}, errAPKManifest
	}
	var pool apkStringPool
	for offset := start; offset < len(data); {
		if len(data)-offset < 8 {
			return apkVersion{}, errAPKManifest
		}
		chunk := data[offset:]
		header := int(binary.LittleEndian.Uint16(chunk[2:]))
		size := uint64(binary.LittleEndian.Uint32(chunk[4:]))
		if header < 8 || size < uint64(header) || size > uint64(len(chunk)) {
			return apkVersion{}, errAPKManifest
		}
		chunk = chunk[:size]
		switch binary.LittleEndian.Uint16(chunk) {
		case 1:
			if pool != nil || header < 28 {
				return apkVersion{}, errAPKManifest
			}
			pool = chunk
		case 0x0102:
			return readManifestAttributes(chunk, header, pool)
		}
		offset += int(size)
	}
	return apkVersion{}, errAPKManifest
}

func readManifestAttributes(chunk []byte, header int, pool apkStringPool) (apkVersion, error) {
	if header < 16 || len(chunk)-header < 20 || pool == nil {
		return apkVersion{}, errAPKManifest
	}
	ext := chunk[header:]
	tag, err := pool.value(binary.LittleEndian.Uint32(ext[4:]), len("manifest"))
	if err != nil || tag != "manifest" {
		return apkVersion{}, errAPKManifest
	}
	start := header + int(binary.LittleEndian.Uint16(ext[8:]))
	width, count := int(binary.LittleEndian.Uint16(ext[10:])), int(binary.LittleEndian.Uint16(ext[12:]))
	if start < header+20 || width < 20 || start > len(chunk) || count > (len(chunk)-start)/width {
		return apkVersion{}, errAPKManifest
	}
	attributes := make(map[string]string)
	for i := 0; i < count; i++ {
		attr := chunk[start+i*width : start+(i+1)*width]
		name, err := pool.value(binary.LittleEndian.Uint32(attr[4:]), 128)
		if err != nil {
			return apkVersion{}, err
		}
		if name != "package" && name != "split" && name != "versionName" && name != "versionCode" && name != "versionCodeMajor" {
			continue
		}
		ns := binary.LittleEndian.Uint32(attr)
		if name == "package" || name == "split" {
			if ns != ^uint32(0) {
				continue
			}
		} else if value, err := pool.value(ns, len(androidXMLNamespace)); err != nil || value != androidXMLNamespace {
			continue
		}
		if _, duplicate := attributes[name]; duplicate {
			return apkVersion{}, errAPKManifest
		}
		var value string
		switch attr[15] {
		case 3:
			maxRunes := 0 // A base APK can only have an empty split name.
			switch name {
			case "package":
				maxRunes = len(androidPackageID)
			case "versionName":
				maxRunes = maxAPKVersionNameRunes
			case "versionCode":
				maxRunes = 10
			case "versionCodeMajor":
				maxRunes = 7
			}
			value, err = pool.value(binary.LittleEndian.Uint32(attr[16:]), maxRunes)
		case 0x10, 0x11:
			value = strconv.FormatUint(uint64(binary.LittleEndian.Uint32(attr[16:])), 10)
		default:
			return apkVersion{}, errAPKManifest
		}
		if err != nil {
			return apkVersion{}, err
		}
		attributes[name] = value
	}
	minor, err := strconv.ParseUint(attributes["versionCode"], 10, 32)
	if err != nil {
		return apkVersion{}, errAPKManifest
	}
	major := uint64(0)
	if value := attributes["versionCodeMajor"]; value != "" {
		major, err = strconv.ParseUint(value, 10, 21)
	}
	code := major<<32 | minor
	name := attributes["versionName"]
	if err != nil || attributes["package"] != androidPackageID || attributes["split"] != "" ||
		code == 0 || code > 1<<53-1 || strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > maxAPKVersionNameRunes ||
		strings.ContainsAny(name, "\x00\r\n") {
		return apkVersion{}, errAPKManifest
	}
	return apkVersion{name: name, code: int64(code)}, nil
}

type apkStringPool []byte

// Resolve only the few strings used by root attributes. Offsets/counts never
// allocate an unbounded string table or expand the rest of the binary XML.
// Bound encoded lengths before decoding, even when many attributes reuse a string.
func (pool apkStringPool) value(index uint32, maxRunes int) (string, error) {
	if len(pool) < 28 {
		return "", errAPKManifest
	}
	count := uint64(binary.LittleEndian.Uint32(pool[8:]))
	header := uint64(binary.LittleEndian.Uint16(pool[2:]))
	start := uint64(binary.LittleEndian.Uint32(pool[20:]))
	if uint64(index) >= count || header+count*4 > uint64(len(pool)) || start < header+count*4 || start >= uint64(len(pool)) {
		return "", errAPKManifest
	}
	offset := start + uint64(binary.LittleEndian.Uint32(pool[header+uint64(index)*4:]))
	if offset >= uint64(len(pool)) {
		return "", errAPKManifest
	}
	data := pool[offset:]
	isUTF8 := binary.LittleEndian.Uint32(pool[16:])&0x100 != 0
	readLength := func() (uint64, bool) {
		if isUTF8 {
			if len(data) < 1 {
				return 0, false
			}
			n := uint64(data[0])
			data = data[1:]
			if n&0x80 != 0 {
				if len(data) < 1 {
					return 0, false
				}
				n = (n&0x7f)<<8 | uint64(data[0])
				data = data[1:]
			}
			return n, true
		}
		if len(data) < 2 {
			return 0, false
		}
		n := uint64(binary.LittleEndian.Uint16(data))
		data = data[2:]
		if n&0x8000 != 0 {
			if len(data) < 2 {
				return 0, false
			}
			n = (n&0x7fff)<<16 | uint64(binary.LittleEndian.Uint16(data))
			data = data[2:]
		}
		return n, true
	}
	n, ok := readLength()
	if !ok || n > uint64(maxRunes)*2 {
		return "", errAPKManifest
	}
	if isUTF8 {
		n, ok = readLength()
		if !ok || n > uint64(maxRunes)*4 || n >= uint64(len(data)) || data[n] != 0 ||
			!utf8.Valid(data[:n]) || utf8.RuneCount(data[:n]) > maxRunes {
			return "", errAPKManifest
		}
		return string(data[:n]), nil
	}
	if n*2+2 > uint64(len(data)) || binary.LittleEndian.Uint16(data[n*2:]) != 0 {
		return "", errAPKManifest
	}
	units := make([]uint16, n)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	value := string(utf16.Decode(units))
	if utf8.RuneCountInString(value) > maxRunes {
		return "", errAPKManifest
	}
	return value, nil
}
