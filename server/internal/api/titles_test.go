package api

import "testing"

func TestGeneratedTitleCleaningAndRejectsNonTitles(t *testing.T) {
	title, err := cleanGeneratedTitle("  \"中国剩余定理的计算与例子\"  ")
	if err != nil || title != "中国剩余定理的计算与例子" {
		t.Fatalf("title=%q error=%v", title, err)
	}
	for _, raw := range []string{"", "标题\n这里是一些说明", string([]byte{0xff})} {
		if _, err := cleanGeneratedTitle(raw); err == nil {
			t.Errorf("accepted non-title %q", raw)
		}
	}
}
