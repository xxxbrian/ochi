package product

import "runtime"

const Version = "0.1.0"

var (
	Revision  = "dev"
	BuiltAt   = ""
	BuildType = "development"
)

func UserAgent() string {
	return "Ochi/" + Version + " (" + runtime.GOOS + "; " + runtime.GOARCH + "; " + runtime.Version() + ")"
}
