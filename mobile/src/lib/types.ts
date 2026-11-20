import type { SpeechOutputFormat } from "../../../shared/speech";

export type * from "../../../shared/contracts";

export type NativeUpload = { uri: string; name: string; mimeType?: string };
export type SynthesizedSpeech = { bytes: Uint8Array; extension: SpeechOutputFormat };
