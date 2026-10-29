# Shared Language Runtime

`i18n/index.ts` is a small platform-independent runtime used by Web and native
clients. It owns the supported locales, BCP 47 system-language resolution,
message interpolation/plurals and locale-aware date/number formatting.
React subscriptions and local/account persistence stay in each client's
`src/lib/i18n.ts`; this module has no UI or storage dependencies.

Messages use semantic keys and provide `en`, `zh-CN` and `zh-TW` explicitly.
Named parameters use `{name}`. A locale value can be `{ one, other }` for
messages whose English grammar depends on the numeric `count` parameter.
Never use user content, model output or upstream diagnostics as translation
keys. UI language does not change the model's response language.

`i18n/errors.ts` reads the same public error catalog embedded by the Go server
at `server/internal/i18n/messages.json`. There is no separately maintained
client copy. This also lets persisted run errors render in the viewer's current
language rather than the language of the request that started the run.
