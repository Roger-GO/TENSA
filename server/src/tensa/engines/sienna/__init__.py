"""The Sienna engine: PowerSystems.jl, PowerFlows.jl and PowerSimulationsDynamics.jl,
held in the session's worker through juliacall.

`envs/` holds the Julia environments the engine runs in, pinned by their manifests;
`julia/` the Julia source the worker loads. See `design/multiengine/spec.md`,
section 9.
"""
