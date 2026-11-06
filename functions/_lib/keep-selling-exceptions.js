// Legacy: Guide id -> the one published project that may keep selling while
// its Guide detail is hidden, as long as its public ticket feed is live. New
// pages use the admin "Keep selling while Guide private" switch instead
// (KEEP_SELLING_FLAG on the project), so this list never grows again.
export const HIDDEN_DETAIL_EXCEPTIONS = Object.freeze({
  "8088": "draft-1791253678425-26c548a5",
  "8266": "draft-1792794458964-79d36de9",
  "8267": "draft-1792794492337-315e4c35",
});
