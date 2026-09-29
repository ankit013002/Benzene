/**
 * Transfer-grant contract between the control plane and the node agent.
 *
 * The control plane issues; the agent verifies. These v2 vectors pin the exact
 * signed storage-format marker for plaintext and encrypted object transfers.
 * Generated fixture — do not edit by hand. The private key is a throwaway.
 */

export interface GrantVector {
  payload: {
    v: 2;
    objectHash: string;
    deviceId: string;
    op: "put" | "get" | "delete";
    exp: number;
    size?: number;
    encryption?: "none" | "benzene-encrypted-object-v1";
  };
  /** The exact `<payload>.<signature>` string the control plane emits. */
  grant: string;
}

export const GRANT_TEST_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAQiXjegSw+hk+G7q3AsZ9Prf9CfvbowdPIkPkR4ASVPU=";

export const GRANT_TEST_PRIVATE_KEY =
  "MC4CAQAwBQYDK2VwBCIEILthpTQ2cP5Ar89gY375YMuTroLxLT56Az5haH/8M1Sj";

export const GRANT_VECTORS: GrantVector[] = [
  {
    payload: {
      v: 2,
      objectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deviceId: "11111111-1111-1111-1111-111111111111",
      op: "put",
      exp: 4102444800,
      size: 1024,
      encryption: "none",
    },
    grant: "eyJ2IjoyLCJvYmplY3RIYXNoIjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsImRldmljZUlkIjoiMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIiwib3AiOiJwdXQiLCJleHAiOjQxMDI0NDQ4MDAsInNpemUiOjEwMjQsImVuY3J5cHRpb24iOiJub25lIn0.aziOyFho4agVlrHH5YGoGOQBV7QgOceEzD4xtqsqb9XuhEOn_uspIZsbCurDNvsRUos4Azkq2k4sRYBqVqNXDA",
  },
  {
    payload: {
      v: 2,
      objectHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      deviceId: "22222222-2222-2222-2222-222222222222",
      op: "put",
      exp: 4102444800,
      size: 1040,
      encryption: "benzene-encrypted-object-v1",
    },
    grant: "eyJ2IjoyLCJvYmplY3RIYXNoIjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImRldmljZUlkIjoiMjIyMjIyMjItMjIyMi0yMjIyLTIyMjItMjIyMjIyMjIyMjIyIiwib3AiOiJwdXQiLCJleHAiOjQxMDI0NDQ4MDAsInNpemUiOjEwNDAsImVuY3J5cHRpb24iOiJiZW56ZW5lLWVuY3J5cHRlZC1vYmplY3QtdjEifQ.qvrhEqY5So5ClAidPJ12LGfPYFMLXEaAsRcyFkXY-MhPHPg1NFJPh_SrUCmy9_MgzHEPo5yapdkEgzGWEDo7AA",
  },
  {
    payload: {
      v: 2,
      objectHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      deviceId: "33333333-3333-3333-3333-333333333333",
      op: "get",
      exp: 4102444800,
      encryption: "none",
    },
    grant: "eyJ2IjoyLCJvYmplY3RIYXNoIjoiY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyIsImRldmljZUlkIjoiMzMzMzMzMzMtMzMzMy0zMzMzLTMzMzMtMzMzMzMzMzMzMzMzIiwib3AiOiJnZXQiLCJleHAiOjQxMDI0NDQ4MDAsImVuY3J5cHRpb24iOiJub25lIn0.WttaTAiVXX3NtDN6Vxq999s9lB0IFQKXoVMezs_JuXJtfr6daYGOn8tURzSIvRK4izaVLKqEQb_PquRB1ln6Dg",
  },
  {
    payload: {
      v: 2,
      objectHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      deviceId: "44444444-4444-4444-4444-444444444444",
      op: "get",
      exp: 4102444800,
      encryption: "benzene-encrypted-object-v1",
    },
    grant: "eyJ2IjoyLCJvYmplY3RIYXNoIjoiZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZCIsImRldmljZUlkIjoiNDQ0NDQ0NDQtNDQ0NC00NDQ0LTQ0NDQtNDQ0NDQ0NDQ0NDQ0Iiwib3AiOiJnZXQiLCJleHAiOjQxMDI0NDQ4MDAsImVuY3J5cHRpb24iOiJiZW56ZW5lLWVuY3J5cHRlZC1vYmplY3QtdjEifQ.oCm1HQ7OPmz851_jeNOHPMWrKKjBvRgWZuAQQGy65eMxS5hJT9JkcZb1gEqQZPiCcu-m9yO0AS3WUPJ_PDWdBA",
  },
  {
    payload: {
      v: 2,
      objectHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      deviceId: "55555555-5555-5555-5555-555555555555",
      op: "delete",
      exp: 4102444800,
    },
    grant: "eyJ2IjoyLCJvYmplY3RIYXNoIjoiZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZSIsImRldmljZUlkIjoiNTU1NTU1NTUtNTU1NS01NTU1LTU1NTUtNTU1NTU1NTU1NTU1Iiwib3AiOiJkZWxldGUiLCJleHAiOjQxMDI0NDQ4MDB9.rghiNmLt4P0MjoLisQe7nyKTPtHU740pidP7vnxN53HnOQNkhcbs1g28CnQrdlhldKRzVCS7Y1k7CRxqmcaNCQ",
  },
];
