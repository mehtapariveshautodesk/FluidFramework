/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { DiscriminatedUnionDispatcher } from "../../codec/index.js";
import {
	Brand,
	Erased,
	MakeNominal,
	brand,
	brandErased,
	fail,
	invertMap,
} from "../../util/index.js";
import {
	FieldKey,
	FieldKindIdentifier,
	FieldSchemaFormat,
	PersistedValueSchema,
	TreeNodeSchemaDataFormat,
	TreeNodeSchemaIdentifier,
} from "./format.js";

/**
 * Schema for what {@link TreeValue} is allowed on a Leaf node.
 * @internal
 */
export enum ValueSchema {
	Number,
	String,
	Boolean,
	FluidHandle,
	Null,
}

/**
 * Set of allowed tree types.
 * Providing multiple values here allows polymorphism, tagged union style.
 *
 * If not specified, types are unconstrained
 * (equivalent to the set containing every TreeNodeSchemaIdentifier defined in the document).
 *
 * Note that even when unconstrained, children must still be in-schema for their own type.
 *
 * In the future, this could be extended to allow inlining a TreeNodeStoredSchema here
 * (or some similar structural schema system).
 * For structural types which could go here, there are a few interesting options:
 *
 * - Allow replacing the whole set with a structural type for terminal / non-tree data,
 * and use this as a replacement for values on the tree nodes.
 *
 * - Allow expression structural constraints for child trees, for example requiring specific traits
 * (ex: via TreeNodeStoredSchema), instead of by type.
 *
 * There are two ways this could work:
 *
 * - Constrain the child nodes based on their shape:
 * this makes schema safe editing difficult because nodes would incur extra editing constraints to prevent them
 * from going out of schema based on their location in such a field.
 *
 * - Constrain the types allowed based on which types guarantee their data will always meet the constraints.
 *
 * Care would need to be taken to make sure this is sound for the schema updating mechanisms.
 * @internal
 */
export type TreeTypeSet = ReadonlySet<TreeNodeSchemaIdentifier> | undefined;

/**
 * Specifies which field kind to use.
 *
 * @remarks
 * This is used instead of just the FieldKindIdentifier so that it can be subtyped into a more expressive type with additional information.
 *
 * @internal
 */
export interface FieldKindSpecifier<T = FieldKindIdentifier> {
	identifier: T;
}

/**
 * Schema for a field.
 * Object implementing this interface should never be modified.
 * @internal
 */
export interface TreeFieldStoredSchema {
	readonly kind: FieldKindSpecifier;
	/**
	 * The set of allowed child types.
	 * If not specified, types are unconstrained.
	 */
	readonly types?: TreeTypeSet;
}

/**
 * Identifier used for the FieldKind for fields which must be empty.
 *
 * @remarks
 * This mainly show up in:
 * 1. The root default field for documents.
 * 2. The schema used for out of schema fields (which thus must be empty/not exist) on object and leaf nodes.
 *
 * @internal
 */
export const forbiddenFieldKindIdentifier = "Forbidden";

/**
 * A schema for empty fields (fields which must always be empty).
 * There are multiple ways this could be encoded, but this is the most explicit.
 */
export const storedEmptyFieldSchema: TreeFieldStoredSchema = {
	// This kind requires the field to be empty.
	kind: { identifier: brand(forbiddenFieldKindIdentifier) },
	// This type set also forces the field to be empty not not allowing any types as all.
	types: new Set(),
};

/**
 * Opaque type erased handle to the encoded representation of the contents of a stored schema.
 * @internal
 */
export interface ErasedTreeNodeSchemaDataFormat extends Erased<"TreeNodeSchemaDataFormat"> {}
export interface BrandedTreeNodeSchemaDataFormat
	extends Brand<TreeNodeSchemaDataFormat, ErasedTreeNodeSchemaDataFormat> {}

/**
 * @internal
 */
export abstract class TreeNodeStoredSchema {
	protected _typeCheck!: MakeNominal;

	/**
	 * @privateRemarks
	 * Returns TreeNodeSchemaDataFormat.
	 * This is uses an opaque type to avoid leaking these types out of the package,
	 * and is runtime validated by the codec.
	 */
	public abstract encode(): ErasedTreeNodeSchemaDataFormat;
}

/**
 * @internal
 */
export class ObjectNodeStoredSchema extends TreeNodeStoredSchema {
	/**
	 * @param objectNodeFields -
	 * Schema for fields with keys scoped to this TreeNodeStoredSchema.
	 * This refers to the TreeFieldStoredSchema directly
	 * (as opposed to just supporting FieldSchemaIdentifier and having a central FieldKey -\> TreeFieldStoredSchema map).
	 * This allows os short friendly field keys which can ergonomically used as field names in code.
	 * It also interoperates well with mapFields being used as a map with arbitrary data as keys.
	 */
	public constructor(
		public readonly objectNodeFields: ReadonlyMap<FieldKey, TreeFieldStoredSchema>,
	) {
		super();
	}

	public override encode(): ErasedTreeNodeSchemaDataFormat {
		const fieldsObject: Record<string, FieldSchemaFormat> = Object.create(null);
		// Sort fields to ensure output is identical for for equivalent schema (since field order is not considered significant).
		// This makes comparing schema easier, and ensures chunk reuse for schema summaries isn't needlessly broken.
		for (const key of [...this.objectNodeFields.keys()].sort()) {
			Object.defineProperty(fieldsObject, key, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: encodeFieldSchema(this.objectNodeFields.get(key) ?? fail("missing field")),
			});
		}
		return brandErased<BrandedTreeNodeSchemaDataFormat>({
			object: fieldsObject,
		});
	}
}

/**
 * @internal
 */
export class MapNodeStoredSchema extends TreeNodeStoredSchema {
	/**
	 * @param mapFields -
	 * Allows using using the fields as a map, with the keys being
	 * FieldKeys and the values being constrained by this TreeFieldStoredSchema.
	 * Usually `FieldKind.Value` should NOT be used here
	 * since no nodes can ever be in schema are in schema if you use `FieldKind.Value` here
	 * (that would require infinite children).
	 */
	public constructor(public readonly mapFields: TreeFieldStoredSchema) {
		super();
	}

	public override encode(): ErasedTreeNodeSchemaDataFormat {
		return brandErased<BrandedTreeNodeSchemaDataFormat>({
			map: encodeFieldSchema(this.mapFields),
		});
	}
}

/**
 * @internal
 */
export class LeafNodeStoredSchema extends TreeNodeStoredSchema {
	/**
	 * @param leafValue -
	 * There are several approaches for how to store actual data in the tree
	 * (special node types, special field contents, data on nodes etc.)
	 * as well as several options about how the data should be modeled at this level
	 * (byte sequence? javascript type? json?),
	 * as well as options for how much of this would be exposed in the schema language
	 * (ex: would all nodes with values be special built-ins, or could any schema add them?)
	 * A simple easy to do in javascript approach is taken here:
	 * this is not intended to be a suggestion of what approach to take, or what to expose in the schema language.
	 * This is simply one approach that can work for modeling them in the internal schema representation.
	 */
	public constructor(public readonly leafValue: ValueSchema) {
		super();
	}

	public override encode(): ErasedTreeNodeSchemaDataFormat {
		return brandErased<BrandedTreeNodeSchemaDataFormat>({
			leaf: encodeValueSchema(this.leafValue),
		});
	}
}

export const storedSchemaDecodeDispatcher: DiscriminatedUnionDispatcher<
	TreeNodeSchemaDataFormat,
	[],
	TreeNodeStoredSchema
> = new DiscriminatedUnionDispatcher({
	leaf: (data: PersistedValueSchema) => new LeafNodeStoredSchema(decodeValueSchema(data)),
	object: (data: Record<TreeNodeSchemaIdentifier, FieldSchemaFormat>) => {
		const map = new Map();
		for (const [key, value] of Object.entries(data)) {
			map.set(key, decodeFieldSchema(value));
		}
		return new ObjectNodeStoredSchema(map);
	},
	map: (data: FieldSchemaFormat) => new MapNodeStoredSchema(decodeFieldSchema(data)),
});

const valueSchemaEncode = new Map([
	[ValueSchema.Number, PersistedValueSchema.Number],
	[ValueSchema.String, PersistedValueSchema.String],
	[ValueSchema.Boolean, PersistedValueSchema.Boolean],
	[ValueSchema.FluidHandle, PersistedValueSchema.FluidHandle],
	[ValueSchema.Null, PersistedValueSchema.Null],
]);

const valueSchemaDecode = invertMap(valueSchemaEncode);

function encodeValueSchema(inMemory: ValueSchema): PersistedValueSchema {
	return valueSchemaEncode.get(inMemory) ?? fail("missing PersistedValueSchema");
}

function decodeValueSchema(inMemory: PersistedValueSchema): ValueSchema {
	return valueSchemaDecode.get(inMemory) ?? fail("missing ValueSchema");
}

export function encodeFieldSchema(schema: TreeFieldStoredSchema): FieldSchemaFormat {
	const out: FieldSchemaFormat = {
		kind: schema.kind.identifier,
	};
	if (schema.types !== undefined) {
		out.types = [...schema.types];
	}
	return out;
}

export function decodeFieldSchema(schema: FieldSchemaFormat): TreeFieldStoredSchema {
	const out: TreeFieldStoredSchema = {
		// TODO: maybe provide actual FieldKind objects here, error on unrecognized kinds.
		kind: { identifier: schema.kind },
		types: schema.types === undefined ? undefined : new Set(schema.types),
	};
	return out;
}

/**
 * Document schema data that can be stored in a document.
 *
 * @remarks
 * Note: the owner of this may modify it over time:
 * thus if needing to hand onto a specific version, make a copy.
 * @internal
 */
export interface TreeStoredSchema extends StoredSchemaCollection {
	/**
	 * Schema for the root field which contains the whole tree.
	 */
	readonly rootFieldSchema: TreeFieldStoredSchema;
}

/**
 * Collection of TreeNodeSchema data that can be stored in a document.
 *
 * @remarks
 * Note: the owner of this may modify it over time:
 * thus if needing to hang onto a specific version, make a copy.
 * @internal
 */
export interface StoredSchemaCollection {
	/**
	 * {@inheritdoc StoredSchemaCollection}
	 */
	readonly nodeSchema: ReadonlyMap<TreeNodeSchemaIdentifier, TreeNodeStoredSchema>;
}
