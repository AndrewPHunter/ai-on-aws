#!/bin/sh
# STAND-IN for the judge adapter, for tests only. NOT a judge. It is run as `stand-in-adapter.sh <schema-file>`, as the
# real adapter is, and answers each request by a word in it, in the shape of the rubric whose schema file it was given.
#   Either rubric: "FAIL" exits 3; "ODD" answers outside the schema; "WRONGSHAPE" answers in the completeness shape
#   whatever the rubric.
#   completeness (verdict.schema.json): "GOOD" correct, "HALF" partly correct, anything else incorrect.
#   answers-question (answers-question.schema.json): "GOOD" yes, uncontradicted, all covered; "HALF" partly, some;
#   "CONTRA" yes but contradicted, some; anything else no, none.
# Each call adds a line to the file named by STAND_IN_CALLS, so a test can see what was asked again.
if [ "${1:-}" = --describe ]; then
  printf '{"judge":"stand-in","model":"none","effort":"none"}\n'
  exit 0
fi
[ -f "${1:-}" ] || exit 2
request=$(cat)
printf 'x\n' >>"${STAND_IN_CALLS:?set STAND_IN_CALLS}"
case "$request" in
  *FAIL*) exit 3 ;;
  *WRONGSHAPE*)
    printf '{"verdict":"correct","reason":"Invented reason."}\n'
    exit 0
    ;;
esac
case "$1" in
  *answers-question.schema.json)
    case "$request" in
      *ODD*) printf '{"answers":"maybe","contradicts":false,"coverage":"all","reason":"Invented reason."}\n' ;;
      *GOOD*) printf '{"answers":"yes","contradicts":false,"coverage":"all","reason":"Invented reason."}\n' ;;
      *HALF*) printf '{"answers":"partly","contradicts":false,"coverage":"some","reason":"Invented reason."}\n' ;;
      *CONTRA*) printf '{"answers":"yes","contradicts":true,"coverage":"some","reason":"Invented reason."}\n' ;;
      *) printf '{"answers":"no","contradicts":false,"coverage":"none","reason":"Invented reason."}\n' ;;
    esac
    ;;
  *)
    case "$request" in
      *ODD*) printf '{"verdict":"maybe"}\n' ;;
      *GOOD*) printf '{"verdict":"correct","reason":"Invented reason."}\n' ;;
      *HALF*) printf '{"verdict":"partly_correct","reason":"Invented reason."}\n' ;;
      *) printf '{"verdict":"incorrect","reason":"Invented reason."}\n' ;;
    esac
    ;;
esac
