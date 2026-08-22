export const QUEST_CLIENT_PROTOCOL = 4;
export const MINIMUM_QUEST_CLIENT_PROTOCOL = 4;

export type ClientProtocolInput = {
  readonly client_protocol?: number;
};

export function clientProtocolInput(): Required<ClientProtocolInput> {
  return { client_protocol: QUEST_CLIENT_PROTOCOL };
}
