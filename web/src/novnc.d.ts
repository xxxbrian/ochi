declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    dragViewport: boolean
    showDotCursor: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(): void
    sendKey(keysym: number, code?: string, down?: boolean): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
  }
}
