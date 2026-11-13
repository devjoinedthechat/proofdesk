# 1. Own agent loop instead of a framework

Status: accepted, 2026-11-13

## Context

The agent takes irreversible actions against systems of record. Every step between a model response and a tool call is a place where a control must sit: policy, token scope, schema checks, spend limits.

Agent frameworks provide that loop ready-made, with their own state, retry and tool-calling conventions.

## Decision

Write the loop by hand on the model API, behind a provider-neutral interface in `packages/gateway`.

## Why

- **Control points stay visible.** Each guardrail is a line in our code, so a reviewer can see what runs before a tool call.
- **Durability belongs to the workflow engine.** A framework's checkpointing would compete with Temporal's (see [ADR 2](0002-temporal-for-durable-execution.md)).
- **The loop is small.** A tool-use loop is a few hundred lines. The hard parts are around it, and a framework does not write those.
- **Fewer moving versions.** Model, prompt and policy versions are pinned per build. A framework adds one more thing that can change behaviour.

## Cost

- Retries and tool dispatch are ours to write and test. Context trimming is not built: a ticket's conversation is short, and the turn limit bounds it.
- No ready-made integrations. Each tool is an MCP server we build.

## When this breaks

With many agents sharing patterns across teams, a shared framework pays for itself in consistency. This repo has one agent.
