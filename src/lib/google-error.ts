import { z } from "zod";

const GoogleErrorResponse = z.object({
  error: z.object({
    status: z.string().optional(),
    message: z.string().optional(),
  }),
});

// Google's own wording ("API key not valid", "has not been used in project …") is what
// tells the owner which setup step was missed. Empty when the body is not Google's error
// shape.
export function googleErrorDetail(body: unknown): string {
  const googleError = GoogleErrorResponse.safeParse(body);
  if (!googleError.success) {
    return "";
  }
  return [googleError.data.error.status, googleError.data.error.message]
    .filter((part) => part !== undefined && part !== "")
    .join(": ");
}
