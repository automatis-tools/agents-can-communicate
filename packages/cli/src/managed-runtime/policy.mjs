export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const networkDisabled = env => !!env?.ACC_NO_UPDATE_CHECK && env.ACC_NO_UPDATE_CHECK !== "0";
export const checkDue = control => !Number.isFinite(Date.parse(control.checkedAt))
  || Date.now() - Date.parse(control.checkedAt) >= CHECK_INTERVAL_MS;
