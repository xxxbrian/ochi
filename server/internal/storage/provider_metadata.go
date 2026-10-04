package storage

import (
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
)

var brandIcons = map[string]string{
	"openai": "openai", "anthropic": "claude-color", "google": "gemini-color",
	"deepseek": "deepseek-color", "xai": "xai", "moonshotai": "kimi",
	"zhipuai": "zhipu-color", "zai": "zhipu-color", "alibaba": "qwen-color",
	"mistral": "mistral-color", "minimax": "minimax-color", "openrouter": "openrouter",
	"github-copilot": "githubcopilot", "siliconflow": "siliconcloud-color",
}

func brandIcon(id string) string {
	if name := brandIcons[id]; name != "" {
		return "/brands/" + name + ".svg"
	}
	return ""
}

func modelVendor(id string) string {
	id = strings.ToLower(id)
	parts := strings.Split(id, "/")
	for _, part := range parts[:len(parts)-1] {
		if brandIcons[part] != "" && part != "openrouter" && part != "siliconflow" {
			return part
		}
	}
	id = parts[len(parts)-1]
	for _, family := range []struct{ prefix, vendor string }{
		{"deepseek", "deepseek"}, {"claude", "anthropic"}, {"gpt", "openai"},
		{"o1", "openai"}, {"o3", "openai"}, {"o4", "openai"}, {"codex", "openai"},
		{"dall-e", "openai"}, {"chatgpt-image", "openai"},
		{"gemini", "google"}, {"gemma", "google"}, {"grok", "xai"},
		{"kimi", "moonshotai"}, {"moonshot", "moonshotai"}, {"glm", "zai"},
		{"qwen", "alibaba"}, {"qwq", "alibaba"}, {"mistral", "mistral"},
		{"codestral", "mistral"}, {"magistral", "mistral"}, {"minimax", "minimax"},
	} {
		if strings.HasPrefix(id, family.prefix) {
			return family.vendor
		}
	}
	return ""
}

func ModelBrandIcon(catalogProvider, catalogModel, model string) string {
	if vendor := modelVendor(catalogModel); vendor != "" {
		return brandIcon(vendor)
	}
	if vendor := modelVendor(model); vendor != "" {
		return brandIcon(vendor)
	}
	return brandIcon(catalogProvider)
}

func providerCatalogID(provider Provider, catalog map[string]CatalogProvider) string {
	if provider.CatalogProviderID != "" {
		return provider.CatalogProviderID
	}
	u, _ := url.Parse(provider.BaseURL)
	if u == nil {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	for domain, id := range map[string]string{
		"api.openai.com": "openai", "api.deepseek.com": "deepseek", "openrouter.ai": "openrouter",
		"api.anthropic.com": "anthropic", "api.x.ai": "xai", "api.moonshot.cn": "moonshotai",
		"api.moonshot.ai": "moonshotai", "api.mistral.ai": "mistral", "api.z.ai": "zai",
		"api.siliconflow.cn": "siliconflow", "api.siliconflow.com": "siliconflow",
	} {
		if host == domain {
			return id
		}
	}
	ids := make([]string, 0, len(catalog))
	for id := range catalog {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		entry := catalog[id]
		api, _ := url.Parse(entry.API)
		if api != nil && api.Hostname() != "" && strings.EqualFold(api.Hostname(), host) {
			return id
		}
	}
	return ""
}

func ProviderBrandIcon(provider Provider) string {
	if icon := brandIcon(providerCatalogID(provider, nil)); icon != "" {
		return icon
	}
	// A custom relay can carry the manufacturer's name in its chosen label.
	for _, word := range strings.Fields(strings.ToLower(provider.Name)) {
		if icon := brandIcon(strings.Trim(word, "-_/()")); icon != "" {
			return icon
		}
	}
	return ""
}

func normalizedModelID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if index := strings.LastIndexByte(id, '/'); index >= 0 {
		id = id[index+1:]
	}
	// Relay variants are only used when the exact ID was not catalogued.
	if strings.HasSuffix(id, ":free") {
		id = strings.TrimSuffix(id, ":free")
	}
	return id
}

func catalogMatches(entry CatalogProvider, id string) []CatalogModel {
	key := normalizedModelID(id)
	items := []CatalogModel{}
	for _, model := range entry.Models {
		if strings.EqualFold(model.ID, id) || normalizedModelID(model.ID) == key ||
			(model.CanonicalModelID != "" && normalizedModelID(model.CanonicalModelID) == key) {
			items = append(items, model)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if strings.EqualFold(a.ID, id) != strings.EqualFold(b.ID, id) {
			return strings.EqualFold(a.ID, id)
		}
		if (a.Status == "deprecated") != (b.Status == "deprecated") {
			return a.Status != "deprecated"
		}
		return a.ID < b.ID
	})
	return items
}

// ResolveCatalogModel prefers a provider's own listing, then a manufacturer's
// exact/canonical identity. It never fuzzy-matches model versions or sizes.
func ResolveCatalogModel(catalog map[string]CatalogProvider, provider Provider, id string) (CatalogModel, string, bool) {
	preferred := providerCatalogID(provider, catalog)
	if preferred != "" {
		if exact, ok := catalog[preferred].Models[id]; ok {
			return exact, "provider-exact", true
		}
		if models := catalogMatches(catalog[preferred], id); len(models) > 0 {
			return models[0], "provider-canonical", true
		}
	}
	vendor := modelVendor(id)
	if models := catalogMatches(catalog[vendor], id); vendor != "" && len(models) > 0 {
		return models[0], "vendor-canonical", true
	}
	identities := map[string]bool{}
	candidates := []CatalogModel{}
	for _, entry := range catalog {
		for _, model := range catalogMatches(entry, id) {
			identity := model.CanonicalModelID
			if identity == "" {
				identity = normalizedModelID(model.ID)
			}
			identities[identity] = true
			candidates = append(candidates, model)
		}
	}
	if len(identities) != 1 || len(candidates) == 0 {
		return CatalogModel{}, "unmatched", false
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if (a.ProviderID == vendor) != (b.ProviderID == vendor) {
			return a.ProviderID == vendor
		}
		return a.ProviderID+"/"+a.ID < b.ProviderID+"/"+b.ID
	})
	return candidates[0], "catalog-exact", true
}

func EnrichCatalogModel(model Model, provider Provider, reference CatalogModel, match string) Model {
	model = ApplyCatalogMetadata(model, reference)
	model.MetadataMatch = match
	if !model.MetadataOverrides["name"] && (model.Name == "" || model.Name == model.Model) && reference.Name != "" {
		model.Name = reference.Name
	}
	if !model.MetadataOverrides["reasoning"] {
		model = catalogReasoningAdapter(model, provider, reference)
	}
	model.Icon = ModelBrandIcon(reference.ProviderID, reference.CanonicalModelID, model.Model)
	model.ProviderIcon = ProviderBrandIcon(provider)
	return model
}

var nativeImageFamily = regexp.MustCompile(`^(gpt-image[^/]*|chatgpt-image-latest|dall-e-[23])$`)

// Vision input and image output are different capabilities. Only documented
// native image families use the Images API without an explicit admin choice.
func InferImageMetadata(model Model) Model {
	if model.MetadataKnown == nil {
		model.MetadataKnown = map[string]bool{}
	}
	id := normalizedModelID(model.Model)
	family := nativeImageFamily.MatchString(id)
	if family && !model.MetadataKnown["modalities"] && !model.MetadataOverrides["modalities"] {
		input := []string{"text", "image"}
		if id == "dall-e-3" {
			input = []string{"text"}
		}
		model.Modalities = Modalities{Input: input, Output: []string{"image"}}
		model.MetadataKnown["modalities"] = true
	}
	if family && !model.MetadataOverrides["supports_vision"] && !model.MetadataKnown["supports_vision"] {
		model.SupportsVision = slices.Contains(model.Modalities.Input, "image")
		model.MetadataKnown["supports_vision"] = true
	}
	if family && !model.MetadataOverrides["supports_tools"] && !model.MetadataKnown["supports_tools"] {
		model.SupportsTools = false
		model.MetadataKnown["supports_tools"] = true
	}
	if family && !model.MetadataOverrides["reasoning"] && (model.ReasoningKind == "" || model.ReasoningKind == "unknown") {
		model.ReasoningKind = "none"
	}
	known := model.MetadataKnown["modalities"] || family
	outputImage := slices.Contains(model.Modalities.Output, "image")
	if known && !model.MetadataOverrides["supports_image_generation"] {
		model.SupportsImageGeneration = outputImage || family
		model.MetadataKnown["supports_image_generation"] = true
	}
	if !model.MetadataOverrides["kind"] && (family || (outputImage && !slices.Contains(model.Modalities.Output, "text"))) {
		model.Kind = "image"
	}
	if model.Kind == "image" {
		model.IsDefault = false
	}
	if family && model.MetadataSource == "unknown" {
		model.MetadataSource = "family"
		model.MetadataMatch = "family"
	}
	if family && model.ImageConfig.SupportsEdit == nil {
		editable := id != "dall-e-3"
		model.ImageConfig.SupportsEdit = &editable
	}
	return model
}

// The selected transport owns the wire field, not the model's upstream brand.
// OpenAI-compatible relays use the same effort field across their vendors.
func CatalogEffortParameter(provider Provider) string {
	switch provider.Protocol {
	case "openai-responses":
		return "reasoning.effort"
	case "openai":
		if providerCatalogID(provider, nil) == "openrouter" {
			return "reasoning.effort"
		}
		return "reasoning_effort"
	default:
		return ""
	}
}

func catalogReasoningAdapter(model Model, provider Provider, reference CatalogModel) Model {
	model.Efforts, model.EffortMapping = []string{}, map[string]json.RawMessage{}
	model.EffortParameter, model.DefaultEffort = "", ""
	if reference.Known["reasoning"] && !reference.Reasoning {
		model.ReasoningKind = "none"
		return model
	}
	var efforts []string
	var toggle bool
	for _, option := range reference.ReasoningOptions {
		if option.Type == "effort" {
			for _, effort := range option.Values {
				if effort != "" && effort != "default" && !slices.Contains(efforts, effort) {
					efforts = append(efforts, effort)
				}
			}
		}
		toggle = toggle || option.Type == "toggle"
	}
	endpoint := providerCatalogID(provider, nil)
	vendor := modelVendor(reference.CanonicalModelID)
	if vendor == "" {
		vendor = modelVendor(model.Model)
	}
	parameter := CatalogEffortParameter(provider)
	if len(efforts) > 0 && parameter != "" {
		if toggle && vendor == "deepseek" && !slices.Contains(efforts, "none") {
			// DeepSeek documents reasoning_effort:none as the non-thinking switch.
			efforts = append([]string{"none"}, efforts...)
		}
		model.ReasoningKind, model.EffortParameter, model.Efforts = "effort", parameter, efforts
		for _, effort := range efforts {
			model.EffortMapping[effort], _ = json.Marshal(effort)
		}
		return model
	}
	if toggle && endpoint == "openrouter" {
		model.ReasoningKind, model.EffortParameter, model.Efforts = "toggle", "reasoning.enabled", []string{"on", "off"}
		model.EffortMapping = map[string]json.RawMessage{"on": json.RawMessage("true"), "off": json.RawMessage("false")}
		return model
	}
	model.ReasoningKind = "unknown"
	return model
}
