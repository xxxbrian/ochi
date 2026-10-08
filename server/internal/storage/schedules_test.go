package storage

import (
	"testing"
	"time"
)

func TestScheduleCalendarAndInterval(t *testing.T) {
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	base := time.Date(2026, 10, 10, 8, 0, 0, 0, shanghai)
	once := base.Add(2 * time.Hour)
	for _, test := range []struct {
		name     string
		schedule Schedule
		want     time.Time
	}{
		{"interval", Schedule{Recurrence: "interval", IntervalMinutes: 90}, base.Add(90 * time.Minute)},
		{"once", Schedule{Recurrence: "once", OnceAt: &once}, once},
		{"daily", Schedule{Recurrence: "daily", TimeOfDay: "09:00"}, time.Date(2026, 10, 10, 9, 0, 0, 0, shanghai)},
		{"weekly", Schedule{Recurrence: "weekly", TimeOfDay: "09:00", Weekdays: []int{1}}, time.Date(2026, 10, 12, 9, 0, 0, 0, shanghai)},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.schedule.Name = "test"
			test.schedule.Prompt = "task"
			test.schedule.Timezone = "Asia/Shanghai"
			got, err := NextScheduleTime(test.schedule, base)
			if err != nil || !got.Equal(test.want) {
				t.Fatalf("next=%v want=%v err=%v", got, test.want, err)
			}
		})
	}
	newYork, _ := time.LoadLocation("America/New_York")
	beforeDST := time.Date(2026, 3, 7, 10, 0, 0, 0, newYork)
	got, err := NextScheduleTime(Schedule{Name: "daily", Prompt: "task", Recurrence: "daily", Timezone: "America/New_York", TimeOfDay: "09:00"}, beforeDST)
	want := time.Date(2026, 3, 8, 9, 0, 0, 0, newYork)
	if err != nil || !got.Equal(want) || got.Sub(beforeDST) != 22*time.Hour {
		t.Fatalf("wall time drift next=%v want=%v err=%v", got, want, err)
	}
	invalid := Schedule{Name: "bad", Prompt: "task", Recurrence: "weekly", Timezone: "Asia/Shanghai", TimeOfDay: "09:00", Weekdays: []int{8}}
	if NormalizeSchedule(&invalid) == nil {
		t.Fatal("invalid weekday accepted")
	}
}
