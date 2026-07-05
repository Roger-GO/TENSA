"""Core domain layer: in-process ANDES wrapper, subprocess worker, session manager.

This subpackage runs *inside* a worker subprocess (wrapper, worker) and *inside*
the FastAPI parent process (session manager). The wrapper is a synchronous Python
class that owns a long-lived ``andes.System``; it is never invoked from the
FastAPI event loop. The session manager spawns one worker subprocess per session
and communicates via two ``multiprocessing.Pipe`` channels (data + control).
"""
