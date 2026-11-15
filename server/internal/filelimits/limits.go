// Package filelimits separates byte transfers from bounded model inputs.
package filelimits

import (
	"os"
	"strconv"
)

const (
	DefaultFileBytes       int64 = 1 << 30
	MultipartOverheadBytes int64 = 1 << 20
	ModelImageBytes        int64 = 8 << 20
	ModelImagesBytes       int64 = 32 << 20
	ImageReferenceBytes    int64 = 32 << 20
	ImageReferencesBytes   int64 = 64 << 20
	SkillBundleBytes       int64 = 32 << 20
	BridgeResponseBytes    int64 = 34 << 20
	BridgeErrorBytes       int64 = 16 << 10
)

// MaxFileBytes is the single-file transfer limit, independent of model budgets.
func MaxFileBytes() int64 {
	value, err := strconv.ParseInt(os.Getenv("OCHI_MAX_FILE_BYTES"), 10, 64)
	if err != nil || value <= 0 || value > (1<<63-1)-MultipartOverheadBytes {
		return DefaultFileBytes
	}
	return value
}
