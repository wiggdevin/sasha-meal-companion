/**
 * The product's public names. The app and its assistant share one name, and the name is an
 * acronym. This is the only runtime file that spells it: tests/tenancy/no-personal-defaults.test.ts
 * allowlists the one line below, so a user's name written as a default anywhere else still fails.
 */
export const APP_NAME = "Sasha";
export const ASSISTANT_NAME = APP_NAME;
export const ASSISTANT_EXPANSION = "Supportive Assistant for Smart Health Awareness";
export const APP_CALENDAR_NAME = `${APP_NAME} Meals`;
