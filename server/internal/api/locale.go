package api

import (
	"context"
	"strings"
	"time"
)

type timezoneKey struct{}

func validTimezone(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 80 || strings.ContainsAny(value, "\x00\r\n") {
		return "UTC"
	}
	if _, err := time.LoadLocation(value); err != nil {
		return "UTC"
	}
	return value
}

func withClientTimezone(ctx context.Context, zone string) context.Context {
	return context.WithValue(ctx, timezoneKey{}, validTimezone(zone))
}

func clientTimezone(ctx context.Context) string {
	zone, _ := ctx.Value(timezoneKey{}).(string)
	return validTimezone(zone)
}
