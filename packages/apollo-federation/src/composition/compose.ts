import 'apollo-server-env';
import 'apollo-env';
import {
  GraphQLSchema,
  extendSchema,
  Kind,
  TypeExtensionNode,
  isTypeDefinitionNode,
  isTypeExtensionNode,
  GraphQLError,
  GraphQLNamedType,
  isObjectType,
  FieldDefinitionNode,
  InputValueDefinitionNode,
  DocumentNode,
  GraphQLObjectType,
  specifiedDirectives,
} from 'graphql';
import { mapValues } from 'apollo-env';
import { transformSchema } from 'apollo-graphql';

import federationDirectives from '../directives';
import {
  findDirectivesOnTypeOrField,
  isStringValueNode,
  parseSelections,
  mapFieldNamesToServiceName,
  stripExternalFieldsFromTypeDefs,
} from './utils';
import {
  ServiceDefinition,
  ServiceName,
  ExternalFieldDefinition,
  ServiceNameToKeyDirectivesMap,
  FederatedTypeDefinitionNode,
} from './types';
import { validateSDL } from 'graphql/validation/validate';
import { compositionRules } from './rules';

// Map of all definitions to eventually be passed to extendSchema
interface DefinitionsMap {
  [name: string]: FederatedTypeDefinitionNode[];
}
// Map of all extensions to eventually be passed to extendSchema
interface ExtensionsMap {
  [name: string]: TypeExtensionNode[];
}

/**
 * A map of base types to their owning service. Used by query planner to direct traffic.
 * This contains the base type's "owner". Any fields that extend this type in another service
 * are listed under "extensionFieldsToOwningServiceMap". extensionFieldsToOwningServiceMap are in the format { myField: my-service-name }
 *
 * Example resulting typeToServiceMap shape:
 *
 * const typeToServiceMap = {
 *   Product: {
 *     serviceName: "ProductService",
 *     extensionFieldsToOwningServiceMap: {
 *       reviews: "ReviewService", // Product.reviews comes from the ReviewService
 *       dimensions: "ShippingService",
 *       weight: "ShippingService"
 *     }
 *   }
 * }
 */
interface TypeToServiceMap {
  [typeName: string]: {
    serviceName?: ServiceName;
    extensionFieldsToOwningServiceMap: { [fieldName: string]: string };
  };
}

/*
 * Map of types to their key directives (maintains association to their services)
 *
 * Example resulting KeyDirectivesMap shape:
 *
 * const keyDirectives = {
 *   Product: {
 *     serviceA: ["sku", "upc"]
 *     serviceB: ["color {id value}"] // Selection node simplified for readability
 *   }
 * }
 */
export interface KeyDirectivesMap {
  [typeName: string]: ServiceNameToKeyDirectivesMap;
}
/**
 * Loop over each service and process its typeDefs (`definitions`)
 * - build up typeToServiceMap
 * - push individual definitions onto either definitionsMap or extensionsMap
 */
export function buildMapsFromServiceList(serviceList: ServiceDefinition[]) {
  const definitionsMap: DefinitionsMap = Object.create(null);
  const extensionsMap: ExtensionsMap = Object.create(null);
  const typeToServiceMap: TypeToServiceMap = Object.create(null);
  const externalFields: ExternalFieldDefinition[] = [];
  const keyDirectivesMap: KeyDirectivesMap = Object.create(null);

  for (const { typeDefs, name: serviceName } of serviceList) {
    // Build a new SDL with @external fields removed, as well as information about
    // the fields that were removed.
    const {
      typeDefsWithoutExternalFields,
      strippedFields,
    } = stripExternalFieldsFromTypeDefs(typeDefs, serviceName);

    externalFields.push(...strippedFields);

    for (let definition of typeDefsWithoutExternalFields.definitions) {
      if (
        definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
        definition.kind === Kind.OBJECT_TYPE_EXTENSION
      ) {
        const typeName = definition.name.value;

        for (const keyDirective of findDirectivesOnTypeOrField(
          definition,
          'key',
        )) {
          if (
            keyDirective.arguments &&
            isStringValueNode(keyDirective.arguments[0].value)
          ) {
            // Initialize the entry for this type if necessary
            keyDirectivesMap[typeName] = keyDirectivesMap[typeName] || {};
            // Initialize the entry for this service if necessary
            keyDirectivesMap[typeName][serviceName] =
              keyDirectivesMap[typeName][serviceName] || [];
            // Add @key metadata to the array
            keyDirectivesMap[typeName][serviceName].push(
              parseSelections(keyDirective.arguments[0].value.value),
            );
          }
        }
      }

      if (isTypeDefinitionNode(definition)) {
        const typeName = definition.name.value;
        /**
         * This type is a base definition (not an extension). If this type is already in the typeToServiceMap, then
         * 1. It was declared by a previous service, but this newer one takes precedence, or...
         * 2. It was extended by a service before declared
         */
        if (typeToServiceMap[typeName]) {
          typeToServiceMap[typeName].serviceName = serviceName;
        } else {
          typeToServiceMap[typeName] = {
            serviceName,
            extensionFieldsToOwningServiceMap: Object.create(null),
          };
        }

        /**
         * If this type already exists in the definitions map, push this definition to the array (newer defs
         * take precedence). If not, create the definitions array and add it to the definitionsMap.
         */
        if (definitionsMap[typeName]) {
          definitionsMap[typeName].push({ ...definition, serviceName });
        } else {
          definitionsMap[typeName] = [{ ...definition, serviceName }];
        }
      } else if (isTypeExtensionNode(definition)) {
        const typeName = definition.name.value;

        /**
         * This definition is an extension of an OBJECT type defined in another service.
         * TODO: handle extensions of non-object types?
         */
        if (
          definition.kind === Kind.OBJECT_TYPE_EXTENSION ||
          definition.kind === Kind.INPUT_OBJECT_TYPE_EXTENSION
        ) {
          if (!definition.fields) break;
          const fields = mapFieldNamesToServiceName<
            FieldDefinitionNode | InputValueDefinitionNode
          >(definition.fields, serviceName);

          /**
           * If the type already exists in the typeToServiceMap, add the extended fields. If not, create the object
           * and add the extensionFieldsToOwningServiceMap, but don't add a serviceName. That will be added once that service
           * definition is processed.
           */
          if (typeToServiceMap[typeName]) {
            typeToServiceMap[typeName].extensionFieldsToOwningServiceMap = {
              ...typeToServiceMap[typeName].extensionFieldsToOwningServiceMap,
              ...fields,
            };
          } else {
            typeToServiceMap[typeName] = {
              extensionFieldsToOwningServiceMap: fields,
            };
          }
        }

        if (definition.kind === Kind.ENUM_TYPE_EXTENSION) {
          if (!definition.values) break;

          const values = mapFieldNamesToServiceName(
            definition.values,
            serviceName,
          );

          if (typeToServiceMap[typeName]) {
            typeToServiceMap[typeName].extensionFieldsToOwningServiceMap = {
              ...typeToServiceMap[typeName].extensionFieldsToOwningServiceMap,
              ...values,
            };
          } else {
            typeToServiceMap[typeName] = {
              extensionFieldsToOwningServiceMap: values,
            };
          }
        }

        /**
         * If an extension for this type already exists in the extensions map, push this extension to the
         * array (since a type can be extended by multiple services). If not, create the extensions array
         * and add it to the extensionsMap.
         */
        if (extensionsMap[typeName]) {
          extensionsMap[typeName].push(definition);
        } else {
          extensionsMap[typeName] = [definition];
        }
      }
    }
  }

  /**
   * what if an extended type doesn't have a base type?
   * - Check each of the extensions, and see if there's a corresponding definition
   * - if so, do nothing. If not, create an empty definition with `null` as the serviceName
   */
  for (const extensionTypeName of Object.keys(extensionsMap)) {
    if (!definitionsMap[extensionTypeName]) {
      definitionsMap[extensionTypeName] = [
        {
          kind: Kind.OBJECT_TYPE_DEFINITION,
          name: { kind: Kind.NAME, value: extensionTypeName },
          fields: [],
          serviceName: null,
        },
      ];

      // ideally, the serviceName would be the first extending service, but there's not a reliable way to
      // trace the extensionNode back to a service since each extension can be overwritten by other extensions
      typeToServiceMap[extensionTypeName].serviceName = null;
    }
  }

  return {
    typeToServiceMap,
    definitionsMap,
    extensionsMap,
    externalFields,
    keyDirectivesMap,
  };
}

export function buildSchemaFromDefinitionsAndExtensions({
  definitionsMap,
  extensionsMap,
}: {
  definitionsMap: DefinitionsMap;
  extensionsMap: ExtensionsMap;
}) {
  let errors: GraphQLError[] | undefined = undefined;

  let schema = new GraphQLSchema({
    query: undefined,
    directives: [...specifiedDirectives, ...federationDirectives],
  });

  // Extend the blank schema with the base type definitions (as an AST node)
  const definitionsDocument: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(definitionsMap).flat(),
  };

  errors = validateSDL(definitionsDocument, schema, compositionRules);
  schema = extendSchema(schema, definitionsDocument, { assumeValidSDL: true });

  // Extend the schema with the extension definitions (as an AST node)
  const extensionsDocument: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: Object.values(extensionsMap).flat(),
  };

  errors.push(...validateSDL(extensionsDocument, schema, compositionRules));

  schema = extendSchema(schema, extensionsDocument, { assumeValidSDL: true });

  return { schema, errors };
}

/**
 * Using the typeToServiceMap, augment the passed in `schema` to add `federation` metadata to the types and
 * fields
 */
export function addFederationMetadataToSchemaNodes({
  schema,
  typeToServiceMap,
  externalFields,
  keyDirectivesMap,
}: {
  schema: GraphQLSchema;
  typeToServiceMap: TypeToServiceMap;
  externalFields: ExternalFieldDefinition[];
  keyDirectivesMap: KeyDirectivesMap;
}) {
  for (const [
    typeName,
    { serviceName: baseServiceName, extensionFieldsToOwningServiceMap },
  ] of Object.entries(typeToServiceMap)) {
    const namedType = schema.getType(typeName) as GraphQLNamedType;

    // Extend each type in the GraphQLSchema with the serviceName that owns it
    // and the key directives that belong to it
    namedType.federation = {
      ...namedType.federation,
      serviceName: baseServiceName,
      ...(keyDirectivesMap[typeName] && {
        keys: keyDirectivesMap[typeName],
      }),
    };

    // For object types, add metadata for all the @provides directives from its fields
    if (isObjectType(namedType)) {
      for (const field of Object.values(namedType.getFields())) {
        const [providesDirective] = findDirectivesOnTypeOrField(
          field.astNode,
          'provides',
        );

        if (
          providesDirective &&
          providesDirective.arguments &&
          isStringValueNode(providesDirective.arguments[0].value)
        ) {
          field.federation = {
            ...field.federation,
            provides: parseSelections(
              providesDirective.arguments[0].value.value,
            ),
          };
        }
      }
    }

    /**
     * For extension fields, do 2 things:
     * 1. Add serviceName metadata to all fields that belong to a type extension
     * 2. add metadata from the @requires directive for each field extension
     */
    for (const [fieldName, extendingServiceName] of Object.entries(
      extensionFieldsToOwningServiceMap,
    )) {
      // TODO: Why don't we need to check for non-object types here
      if (isObjectType(namedType)) {
        const field = namedType.getFields()[fieldName];
        field.federation = {
          ...field.federation,
          serviceName: extendingServiceName,
        };

        const [requiresDirective] = findDirectivesOnTypeOrField(
          field.astNode,
          'requires',
        );

        if (
          requiresDirective &&
          requiresDirective.arguments &&
          isStringValueNode(requiresDirective.arguments[0].value)
        ) {
          field.federation = {
            ...field.federation,
            requires: parseSelections(
              requiresDirective.arguments[0].value.value,
            ),
          };
        }
      }
    }
  }
  // add externals metadata
  for (const field of externalFields) {
    const namedType = schema.getType(field.parentTypeName) as GraphQLNamedType;
    if (!namedType) continue;

    namedType.federation = {
      ...namedType.federation,
      externals: {
        ...(namedType.federation && namedType.federation.externals),
        [field.serviceName]: [
          ...(namedType.federation &&
          namedType.federation.externals &&
          namedType.federation.externals[field.serviceName]
            ? namedType.federation.externals[field.serviceName]
            : []),
          field,
        ],
      },
    };
  }
}

export function composeServices(services: ServiceDefinition[]) {
  const {
    typeToServiceMap,
    definitionsMap,
    extensionsMap,
    externalFields,
    keyDirectivesMap,
  } = buildMapsFromServiceList(services);

  let { schema, errors } = buildSchemaFromDefinitionsAndExtensions({
    definitionsMap,
    extensionsMap,
  });

  // TODO: We should fix this to take non-default operation root types in
  // implementing services into account.

  const operationTypeMap = {
    query: 'Query',
    mutation: 'Mutation',
    subscription: 'Subscription',
  };

  schema = new GraphQLSchema({
    ...schema.toConfig(),
    ...mapValues(operationTypeMap, typeName =>
      typeName
        ? (schema.getType(typeName) as GraphQLObjectType<any, any>)
        : undefined,
    ),
  });

  // If multiple type definitions and extensions for the same type implement the
  // same interface, it will get added to the constructed object multiple times,
  // resulting in a schema validation error. We therefore need to remove
  // duplicate interfaces from object types manually.
  schema = transformSchema(schema, type => {
    if (isObjectType(type)) {
      const config = type.toConfig();
      return new GraphQLObjectType({
        ...config,
        interfaces: Array.from(new Set(config.interfaces)),
      });
    }
    return undefined;
  });

  addFederationMetadataToSchemaNodes({
    schema,
    typeToServiceMap,
    externalFields,
    keyDirectivesMap,
  });

  /**
   * At the end, we're left with a full GraphQLSchema that _also_ has `serviceName` fields for every type,
   * and every field that was extended. Fields that were _not_ extended (added on the base type by the owner),
   * there is no `serviceName`, and we should refer to the type's `serviceName`
   */
  return { schema, errors };
}
