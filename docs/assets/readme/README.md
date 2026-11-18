# README media

Ochi's Web, iOS, and Android screenshots, animations, and mechanism diagrams.
The examples follow a seven-day support report from analysis to delivery.

## Assets

| Asset | Content |
| --- | --- |
| [`hero.webp`](hero.webp) | Web conversation and report side panel, alongside the native iOS app. |
| [`mobile.webp`](mobile.webp) | iOS file output, Android dark-mode reading, and the native PDF viewer. |
| [`computer.webp`](computer.webp) | Computer viewer connected to a Linux/XFCE desktop with the report open. |
| [`computer-handoff.webp`](computer-handoff.webp) | Computer permission and user takeover at a sign-in page. |
| [`tool-chain.webp`](tool-chain.webp) | An expanded process with source reading, analysis, report generation, and file delivery. |
| [`process.gif`](process.gif) | Streaming progress in the Web client's compact process view. |
| [`process-expanded.gif`](process-expanded.gif) | The same task with the process and tool group expanded as steps arrive. |
| [`tool-chain.gif`](tool-chain.gif) | Expanding grouped tools, inspecting command results, and opening the HTML report. |
| [`ios-preview.gif`](ios-preview.gif) | Opening an image and dragging the full-screen preview back into the conversation. |
| [`agent-loop.svg`](agent-loop.svg) | Server-owned inputs, model/tool feedback, execution evidence, and ordered public items shared by all clients. |
| [`context.svg`](context.svg) | Stable context assembly, scoped state, selective Skill/MCP details, and usage-calibrated compaction. |
| [`memory.svg`](memory.svg) | Task-local continuity, durable-memory admission, bounded recall, and the memory-off boundary. |
| [`computer.svg`](computer.svg) | Independent compute, FIFO admission for shared resources, foreground waits, checkpoints, and owned Jobs. |
| [`report-cover.webp`](report-cover.webp) | The monochrome support report. |

## Appearance and capture

The Web captures use Ochi's Mono theme in light appearance. Native captures use
Release build 14 in the iOS Simulator and Android emulator, with light and dark
appearances and standardized status bars.

The Computer viewer connects to a Linux/XFCE workspace. The handoff shows a
permission request, user takeover, and a sign-in page. Returning desktop control
and confirming the pending request are separate actions.

Compositions use neutral framing, captions, and borders around uniformly scaled
captures. Animations retain the recorded interaction speed, with static waiting
intervals trimmed for playback.

## Maintaining the assets

The four SVGs explain the current implementation; the
[architecture document](../../architecture.md) owns the detailed contracts.

When refreshing screenshots or recordings, use the current interfaces and theme,
keep text legible at normal README width, and check the final stills, animation
playback, and links.
