# Driving NanoClaw

NanoClaw is a conversational personal assistant that is ALREADY running in this
DTU. It is the system under test. Your job is to relay the task to NanoClaw and
observe what it produces. Do NOT do the task yourself, and do NOT write the
deliverable yourself. Only talk to NanoClaw.

## How to send one chat turn

Run exactly this command (substitute your message for `<message>`):

    su - nano -c 'cd /home/nano/nanoclaw && pnpm run chat "<message>"'

- Phrase the task as a natural-language request, the way a real user would.
- The task scenario names the output file it expects (for example
  `Conclusion.txt`, `data_analysis_answer.txt`, a generated tool plus a README).
  Ask NanoClaw to save its work to that file in its current working directory.
- NanoClaw's working directory on the host is the workspace path you were given.
  Its deliverables land there.

## CRITICAL: how to know a turn is actually done

`pnpm run chat` returns after about 120 seconds OR after a brief silence, which
is very often BEFORE NanoClaw has finished. The reply printing to the screen does
NOT mean the work is complete. NanoClaw keeps working in the background after the
command returns.

Never treat the chat command returning as "the task is done." Instead, confirm
the deliverable by polling the working directory:

1. After sending the task, list the working directory:

       su - nano -c 'ls -la <workspace path>'

2. When the expected output file appears, check that it has stopped growing:
   read its size, wait about 20 seconds, read its size again. Consider the file
   stable only when it EXISTS and its size is unchanged across two consecutive
   checks at least ~20 seconds apart.

3. If nothing appears after a reasonable wait, send a short follow-up turn
   ("Are you finished? Where did you save the output?") and keep polling.

Only after you have confirmed the expected deliverable exists and is stable
should you call the `conclude` tool. Set the verdict to `success` only if the
deliverable is present and plausibly addresses the task; otherwise use `partial`
or `failure` and explain what was missing in your reasoning.
