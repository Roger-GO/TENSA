# TensaSiennaNet.jl: the network matrices of TENSA's Sienna engine, with
# PowerNetworkMatrices (PNM). Included after TensaSienna.jl, and only when a
# session first asks for a matrix, so a session that only solves power flows
# never builds one. It reaches the first module as Main.TensaSienna, which is
# where both files live when the tests and the Python worker include them into
# Main. The one public function answers a JSON string.

module TensaSiennaNet

import Main.TensaSienna as TS

const PSY = TS.PSY
const PNM = TS.PNM

export network_matrix_json

const KINDS = ("ptdf", "lodf", "ybus", "incidence")

# An arc axis entry as (from, to) bus numbers.
_arc_entry(arc) = Dict{String, Any}("from" => arc[1], "to" => arc[2])

# Write a matrix as raw Float64, column-major, with no header. Every matrix is
# made a dense Float64 matrix first: PowerNetworkMatrices 0.20 keeps the Ybus as
# ComplexF32 (its parts are Float32, 4 bytes each), the PTDF as a transposed view
# of what it stores, and the incidence matrix sparse; the reader on the Python
# side reads 8-byte values in column-major order and nothing else.
function _write_matrix(file::AbstractString, matrix)
    open(file, "w") do io
        write(io, Matrix{Float64}(matrix))
    end
    return nothing
end

"""
    network_matrix_json(s::TS.Session; kind, file) -> String

Build one network matrix of the loaded case with PowerNetworkMatrices and
write it to `file` as raw Float64, column-major, with no header. `kind` is
"ptdf", "lodf", "ybus" or "incidence". A complex matrix (ybus) is written as
two files, `<file>.re` and `<file>.im`. The answer is a JSON object with the
kind, the shape, the axes (arc entries `{"from", "to"}` or bus numbers), the
basename of the file or files written, the reference buses (not for ybus) and
`distributed_slack` false. Throws an `ArgumentError` for a kind it does not
know; a matrix PowerNetworkMatrices cannot build propagates as thrown.
"""
function network_matrix_json(s::TS.Session; kind::AbstractString, file::AbstractString)::String
    kind in KINDS || throw(ArgumentError("unknown network matrix kind: $(kind)"))
    base = basename(String(file))
    if kind == "ptdf"
        m = PNM.PTDF(s.sys)
        data = PNM.get_ptdf_data(m)
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    elseif kind == "lodf"
        m = PNM.LODF(s.sys)
        data = PNM.get_lodf_data(m)
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    elseif kind == "ybus"
        m = PNM.Ybus(s.sys)
        data = Matrix(m.data)
        _write_matrix(String(file) * ".re", real(data))
        _write_matrix(String(file) * ".im", imag(data))
        rows = Any[Int(b) for b in PNM.get_bus_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = nothing
        complex = true
        files = Any[base * ".re", base * ".im"]
    else
        m = PNM.IncidenceMatrix(s.sys)
        data = Float64.(Matrix(m.data))
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    end
    n_rows, n_cols = size(data)
    answer = Dict{String, Any}(
        "kind" => String(kind),
        "n_rows" => n_rows,
        "n_cols" => n_cols,
        "complex" => complex,
        "file" => first(files),
        "files" => files,
        "rows" => rows,
        "cols" => cols,
        "distributed_slack" => false,
    )
    ref_buses === nothing || (answer["ref_buses"] = ref_buses)
    return TS._to_json(answer)
end

end # module
