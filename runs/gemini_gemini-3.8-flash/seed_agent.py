import os
from openhands.sdk import LLM
from openhands_cli.stores import agent_store as s
llm = LLM(model=os.environ["LLM_MODEL"], api_key=os.environ["LLM_API_KEY"],
          base_url=os.environ.get("LLM_BASE_URL") or None, usage_id="agent",
          reasoning_effort=os.environ.get("LLM_REASONING_EFFORT", "medium"),
          caching_prompt=os.environ.get("LLM_CACHING_PROMPT", "true").lower() != "false",
          num_retries=int(os.environ.get("LLM_NUM_RETRIES", "5")), retry_max_wait=120)
s.AgentStore().save(s.get_default_cli_agent(llm))
print(f"seeded agent: {llm.model} reasoning_effort={llm.reasoning_effort} caching_prompt={llm.caching_prompt} num_retries={llm.num_retries}", flush=True)
