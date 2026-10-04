/** Raised where the Python oracle raises ``ValueError``: a well-typed argument with a bad value. */
export class ValueError extends Error {
  override readonly name = "ValueError";
}
