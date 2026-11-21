// Only errors created by our deployment guards may be printed to Actions logs.
// Driver/CLI/network errors may contain connection strings, SQL or row values.
export class DeploymentError extends Error {}
