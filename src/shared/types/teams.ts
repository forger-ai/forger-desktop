export interface TeamDemoRequestInput {
  name: string;
  email: string;
  phone: string;
  useCase: string;
  website?: string;
}

export interface TeamDemoRequestResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
}
