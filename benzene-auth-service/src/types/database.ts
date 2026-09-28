export interface Credential {
  id: string;
  email: string;
  password_hash: string;
  email_verified: boolean;
  account_status: "active" | "deletion_requested";
  created_at: Date;
  updated_at: Date;
}

export interface RefreshToken {
  id: string;
  credential_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface EmailVerificationToken {
  id: string;
  credential_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
}

export interface PasswordResetToken {
  id: string;
  credential_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}
