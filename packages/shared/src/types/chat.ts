export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
  reply: string;
}
