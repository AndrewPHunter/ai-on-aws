#!/bin/sh
# STAND-IN for the model adapters (evaluation/judge/codex.sh, evaluation/reword/codex.sh), for tests only. NOT a model.
# Run as `stand-in-adapter.sh <schema-file>`, as the real ones are. It appends each request it is given, as one line,
# to the file named by STAND_IN_LOG, and answers by the schema file's name and a word in the request:
#   answers-question: "FAIL" exits 3, "ODD" answers outside the schema, "GOOD" yes, uncontradicted; else no.
#   verdict (completeness): "GOOD" correct; else incorrect.
#   rewrite: "RWFAIL" exits 3, "RWODD" answers outside the schema, "NONAME" a rewrite without the drug's name, "DIFF"
#     a rewrite the checker judges different; else a rewrite with the name.
#   same (the checker): "CKFAIL" exits 4, "DIFF" not the same; else the same.
if [ "${1:-}" = --describe ]; then
  printf '{"judge":"stand-in","rewriter":"stand-in","model":"none","effort":"none"}\n'
  exit 0
fi
[ -f "${1:-}" ] || exit 2
request=$(cat)
printf '%s\n' "$request" >>"${STAND_IN_LOG:?set STAND_IN_LOG}"
reason='"reason":"Invented reason."'
case "$1:$request" in
  *answers-question.schema.json:*FAIL*) exit 3 ;;
  *answers-question.schema.json:*ODD*) printf '{"answers":"maybe"}\n' ;;
  *answers-question.schema.json:*GOOD*) printf '{"answers":"yes","contradicts":false,"coverage":"all",%s}\n' "$reason" ;;
  *answers-question.schema.json:*) printf '{"answers":"no","contradicts":false,"coverage":"none",%s}\n' "$reason" ;;
  *verdict.schema.json:*GOOD*) printf '{"verdict":"correct",%s}\n' "$reason" ;;
  *verdict.schema.json:*) printf '{"verdict":"incorrect",%s}\n' "$reason" ;;
  *rewrite.schema.json:*RWFAIL*) exit 3 ;;
  *rewrite.schema.json:*RWODD*) printf '{"text":"Rephrased."}\n' ;;
  *rewrite.schema.json:*NONAME*) printf '{"question":"Rephrased, with no name?"}\n' ;;
  *rewrite.schema.json:*DIFF*) printf '{"question":"Rephrased Examplamab question, DIFF?"}\n' ;;
  *rewrite.schema.json:*) printf '{"question":"Rephrased Examplamab question?"}\n' ;;
  *same.schema.json:*CKFAIL*) exit 4 ;;
  *same.schema.json:*DIFF*) printf '{"same":false,%s}\n' "$reason" ;;
  *same.schema.json:*) printf '{"same":true,%s}\n' "$reason" ;;
  *) exit 2 ;;
esac
