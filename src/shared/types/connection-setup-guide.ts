export type ConnectionSetupGuideCopyKind = 'callback_url' | 'scope' | 'permission' | 'field' | 'url';

export interface ConnectionSetupGuideLink {
  label: string;
  url: string;
}

export interface ConnectionSetupGuideCopyValue {
  label: string;
  value: string;
  kind: ConnectionSetupGuideCopyKind;
}

export interface ConnectionSetupGuide {
  title: string;
  summary: string;
  portal?: ConnectionSetupGuideLink;
  steps: string[];
  copyValues?: ConnectionSetupGuideCopyValue[];
  notes?: string[];
  commonErrors?: string[];
}
