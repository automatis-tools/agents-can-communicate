import { AccError, EXIT } from "@agents-can-communicate/protocol";

export function assertPublicationDeadline(deadlineAt) {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new AccError(EXIT.CONFLICT, "operation deadline expired before publication", {});
  }
}
