package agent

import "context"

// ExtensionAccess is resolved by the server from administrator catalog policy
// and the current user's preferences, never from model-supplied arguments.
type ExtensionAccess struct {
	Skills []string `json:"skills"`
	MCP    []string `json:"mcp"`
}

type extensionAccessKey struct{}

func WithExtensionAccess(ctx context.Context, access ExtensionAccess) context.Context {
	// Empty lists must be encoded as [] rather than null in the bridge contract.
	access.Skills = append([]string{}, access.Skills...)
	access.MCP = append([]string{}, access.MCP...)
	return context.WithValue(ctx, extensionAccessKey{}, access)
}

func ExtensionAccessFromContext(ctx context.Context) (ExtensionAccess, bool) {
	access, ok := ctx.Value(extensionAccessKey{}).(ExtensionAccess)
	return access, ok
}
