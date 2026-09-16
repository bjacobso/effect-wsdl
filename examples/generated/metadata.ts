import type { Operation, Type } from "effect-wsdl/model";
export const types: Readonly<Record<string, Type>> = {
  "{http://www.w3.org/2001/XMLSchema}decimal": {
    "kind": "primitive",
    "primitive": "decimal"
  },
  "{http://www.w3.org/2001/XMLSchema}string": {
    "kind": "primitive",
    "primitive": "string"
  },
  "{urn:orders}GetOrder#type": {
    "kind": "complex",
    "elements": [
      {
        "namespace": "urn:orders",
        "local": "orderId",
        "type": "{http://www.w3.org/2001/XMLSchema}string",
        "min": 1,
        "max": 1,
        "nillable": false
      }
    ],
    "attributes": []
  },
  "{urn:orders}GetOrderResponse#type": {
    "kind": "complex",
    "elements": [
      {
        "namespace": "urn:orders",
        "local": "orderId",
        "type": "{http://www.w3.org/2001/XMLSchema}string",
        "min": 1,
        "max": 1,
        "nillable": false
      },
      {
        "namespace": "urn:orders",
        "local": "status",
        "type": "{urn:orders}Status",
        "min": 1,
        "max": 1,
        "nillable": false
      },
      {
        "namespace": "urn:orders",
        "local": "total",
        "type": "{http://www.w3.org/2001/XMLSchema}decimal",
        "min": 1,
        "max": 1,
        "nillable": false
      }
    ],
    "attributes": []
  },
  "{urn:orders}OrderNotFound#type": {
    "kind": "complex",
    "elements": [
      {
        "namespace": "urn:orders",
        "local": "orderId",
        "type": "{http://www.w3.org/2001/XMLSchema}string",
        "min": 1,
        "max": 1,
        "nillable": false
      }
    ],
    "attributes": []
  },
  "{urn:orders}Status": {
    "kind": "primitive",
    "primitive": "string",
    "enumeration": [
      "pending",
      "shipped"
    ]
  }
};
export const operations: readonly Operation[] = [
  {
    "name": "GetOrder",
    "action": "urn:orders/GetOrder",
    "input": {
      "namespace": "urn:orders",
      "local": "GetOrder",
      "type": "{urn:orders}GetOrder#type",
      "min": 1,
      "max": 1,
      "nillable": false
    },
    "output": {
      "namespace": "urn:orders",
      "local": "GetOrderResponse",
      "type": "{urn:orders}GetOrderResponse#type",
      "min": 1,
      "max": 1,
      "nillable": false
    },
    "faults": [
      {
        "name": "OrderNotFound",
        "element": {
          "namespace": "urn:orders",
          "local": "OrderNotFound",
          "type": "{urn:orders}OrderNotFound#type",
          "min": 1,
          "max": 1,
          "nillable": false
        }
      }
    ]
  }
];
export const names: Readonly<Record<string, string>> = Object.fromEntries([
  [
    "GetOrder",
    "getOrder"
  ]
]);
