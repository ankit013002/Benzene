export type ActionErrors = Partial<
  Record<"email" | "password" | "confirmPassword" | "general", string>
>;

export type ActionState =
  | { ok?: boolean; message?: string; errors?: ActionErrors }
  | undefined;
