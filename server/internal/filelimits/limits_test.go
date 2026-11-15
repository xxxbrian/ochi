package filelimits

import "testing"

func TestFileTransferConfigurationDoesNotChangeContextBudgets(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "bad", "9223372036854775807"} {
		t.Setenv("OCHI_MAX_FILE_BYTES", value)
		if MaxFileBytes() != 1<<30 {
			t.Fatalf("invalid limit %q changed the default", value)
		}
	}
	t.Setenv("OCHI_MAX_FILE_BYTES", "2147483648")
	if MaxFileBytes() != 2<<30 || ModelImageBytes != 8<<20 || ModelImagesBytes != 32<<20 || SkillBundleBytes != 32<<20 {
		t.Fatal("transfer configuration changed model or control budgets")
	}
}
