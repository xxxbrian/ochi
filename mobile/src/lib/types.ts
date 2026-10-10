// The native client consumes the same persisted domain and run event contract.
export type * from '../../../web/src/lib/types';

export type NativeUpload = { uri: string; name: string; mimeType?: string };
export type RunOptions = {
  model_id?: string;
  effort?: string;
  attachment_ids?: string[];
  edit_message_id?: string;
  retry_run_id?: string;
  stop_current?: boolean;
  budget_tokens?: number;
  reasoning_enabled?: boolean;
};
export type SessionPatch = {
  title?: string;
  model_id?: string;
  effort?: string;
  computer_enabled?: boolean;
  remember_computer_default?: boolean;
};
