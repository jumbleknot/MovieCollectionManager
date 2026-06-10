package mcm.agent_token_exchange

import rego.v1

default allow := false

# An agent-origin caller may exchange ONLY for the mc-service audience (research R3/R16).
allow if {
    input.agent_origin == true
    input.audience == "mc-service"
}
