/** Tests exercise their own API default and explicit overrides, independently
 * of the loopback URL embedded by the preceding application build. */
export function frontendTestEnvironment(runtimeEnvironment) {
  const environment = { ...runtimeEnvironment };
  delete environment.VITE_API_BASE_URL;
  return environment;
}
