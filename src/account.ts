/** The provider family of an account-scoped provider: `anthropic-account-2` -> `anthropic`. */
export const accountGroup = (provider: string) => provider.replace(/-account-\d+$/, '');
