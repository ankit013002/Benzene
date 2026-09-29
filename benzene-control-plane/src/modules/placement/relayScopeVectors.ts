/**
 * Public conformance vector shared byte-for-byte between both relay peers.
 * The signature was made with the repository's existing throwaway test key;
 * that public fixture is safe for tests only, and the private key is not used
 * by this vector or at runtime.
 */
export const RELAY_SCOPE_VECTOR = {
  scope: {
    v: 1,
    sessionId: "11111111-1111-4111-8111-111111111111",
    ticketId: "22222222-2222-4222-8222-222222222222",
    storageHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    deviceId: "33333333-3333-4333-8333-333333333333",
    op: "get",
    role: "node",
    exp: 4102444800,
    maxBytes: 1024,
  },
  token: "eyJ2IjoxLCJzZXNzaW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJ0aWNrZXRJZCI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiIsInN0b3JhZ2VIYXNoIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsImRldmljZUlkIjoiMzMzMzMzMzMtMzMzMy00MzMzLTgzMzMtMzMzMzMzMzMzMzMzIiwib3AiOiJnZXQiLCJyb2xlIjoibm9kZSIsImV4cCI6NDEwMjQ0NDgwMCwibWF4Qnl0ZXMiOjEwMjR9.9pbFHQHQj7rVgMRvY469UUoxvEpGTYBvlxMiR2jqN1B1s5_lfBq6qgn6l0HoxRFQTArbb_WcBrnUtPOSfm8SCw",
  publicKey: "MCowBQYDK2VwAyEAQiXjegSw+hk+G7q3AsZ9Prf9CfvbowdPIkPkR4ASVPU=",
} as const;
