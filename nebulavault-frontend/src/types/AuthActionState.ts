export type ActionErrors = Partial<
  Record<"name" | "email" | "password" | "confirmPassword" | "general", string>
>;

export type ActionState =
  | { ok?: boolean; message?: string; errors?: ActionErrors }
  | undefined;
