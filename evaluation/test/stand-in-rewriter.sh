#!/bin/sh
# STAND-IN for the rewriter adapter (evaluation/reword/codex.sh), for tests only. NOT a rewriter. It is run as
# `stand-in-rewriter.sh <schema-file>`, as the real adapter is, and answers each request by a word in it. The drug's
# name in every test is the invented "Examplamab".
#   A rewrite request (it holds "drug_name"): "RWFAIL" exits 3; "RWODD" answers outside the schema; "SAMEAGAIN" returns
#   "What Examplamab dose, SAMEAGAIN?" again with only case and spacing changed; "NONAME" returns a
#   rewrite without the drug's name; "DIFF" a rewrite the checker below judges different; "CKFAIL" a rewrite whose check
#   call fails; anything else a rewrite with the drug's name.
#   A check request: a rewrite holding "CHECKFAIL" exits 4; one holding "DIFFERENT" is not the same; anything else is.
# Each call adds a line, "rewrite" or "check", to the file named by STAND_IN_CALLS.
if [ "${1:-}" = --describe ]; then
  printf '{"rewriter":"stand-in","model":"none","effort":"none"}\n'
  exit 0
fi
[ -f "${1:-}" ] || exit 2
request=$(cat)
case "$request" in
  *'"drug_name"'*)
    printf 'rewrite\n' >>"${STAND_IN_CALLS:?set STAND_IN_CALLS}"
    case "$request" in
      *RWFAIL*) exit 3 ;;
      *RWODD*) printf '{"text":"Rephrased."}\n' ;;
      *SAMEAGAIN*) printf '{"question":"what  examplamab DOSE, sameagain?"}\n' ;;
      *NONAME*) printf '{"question":"Rephrased query with no name?"}\n' ;;
      *DIFF*) printf '{"question":"Rephrased Examplamab query, DIFFERENT?"}\n' ;;
      *CKFAIL*) printf '{"question":"Rephrased Examplamab query, CHECKFAIL?"}\n' ;;
      *) printf '{"question":"Rephrased Examplamab query?"}\n' ;;
    esac
    ;;
  *)
    printf 'check\n' >>"${STAND_IN_CALLS:?set STAND_IN_CALLS}"
    case "$request" in
      *CHECKFAIL*) exit 4 ;;
      *DIFFERENT*) printf '{"same":false,"reason":"Invented reason."}\n' ;;
      *) printf '{"same":true,"reason":"Invented reason."}\n' ;;
    esac
    ;;
esac
