export type MessagingChannel = 'telegram' | 'whatsapp' | 'app';

export interface ChannelUserRef {
  channel: MessagingChannel;
  channelUserId: string;
}

export type InboundMessageType = 'text' | 'voice' | 'photo' | 'location' | 'contact' | 'action';

export interface InboundContact {
  userId?: string;
  phoneNumber: string;
}

export interface InboundMessage {
  channel: MessagingChannel;
  channelUserId: string;
  userId?: string;
  type: InboundMessageType;
  text?: string;
  mediaRef?: string;
  location?: { lat: number; lng: number };
  action?: { name: string; payload: Record<string, unknown> };
  contact?: InboundContact;
  receivedAt: string;
}

export type OutboundButton =
  | { text: string; kind: 'request_contact' }
  | { text: string; kind: 'action'; action: string; payload?: Record<string, unknown> };

export interface OutboundMessage {
  to: ChannelUserRef;
  text: string;
  buttons?: readonly OutboundButton[];
}

export type MessagingError =
  | { kind: 'blocked_by_user' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid_recipient' }
  | { kind: 'unavailable'; retryable: boolean };
