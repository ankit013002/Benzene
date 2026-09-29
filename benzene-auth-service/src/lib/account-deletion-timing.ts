import { ACCESS_TOKEN_LIFETIME_SECONDS } from "./token.constants";

// The gateway checks exp strictly with no configured JWT leeway. This extra
// minute covers small clock differences between the auth service and gateway.
export const ACCESS_TOKEN_CLOCK_SKEW_MARGIN_SECONDS = 60;
export const STORED_OBJECTS_DELETION_GRACE_SECONDS =
  ACCESS_TOKEN_LIFETIME_SECONDS + ACCESS_TOKEN_CLOCK_SKEW_MARGIN_SECONDS;
