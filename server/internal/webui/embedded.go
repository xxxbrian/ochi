//go:build embed

package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var frontend embed.FS

const Embedded = true

func Wrap(api http.Handler) http.Handler {
	assets, err := fs.Sub(frontend, "dist")
	if err != nil {
		panic(err)
	}
	return withAssets(api, assets)
}
