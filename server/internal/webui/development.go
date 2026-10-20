//go:build !embed

package webui

import "net/http"

const Embedded = false

func Wrap(api http.Handler) http.Handler { return api }
