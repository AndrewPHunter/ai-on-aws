#!/bin/sh
# STAND-IN for the judge adapter, for tests only. NOT a judge. It answers each request by a word in it: "GOOD"
# correct, "HALF" partly correct, "FAIL" exits 3, "ODD" answers outside the schema, anything else incorrect. Each call
# adds a line to the file named by STAND_IN_CALLS, so a test can see what was asked again.
if [ "${1:-}" = --describe ]; then
  printf '{"judge":"stand-in","model":"none","effort":"none"}\n'
  exit 0
fi
request=$(cat)
printf 'x\n' >>"${STAND_IN_CALLS:?set STAND_IN_CALLS}"
case "$request" in
  *FAIL*) exit 3 ;;
  *ODD*) printf '{"verdict":"maybe"}\n' ;;
  *GOOD*) printf '{"verdict":"correct","reason":"Invented reason."}\n' ;;
  *HALF*) printf '{"verdict":"partly_correct","reason":"Invented reason."}\n' ;;
  *) printf '{"verdict":"incorrect","reason":"Invented reason."}\n' ;;
esac
