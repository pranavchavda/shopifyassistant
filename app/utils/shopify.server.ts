/**
 * Shopify Admin API client for GraphQL operations
 * Provides functions to interact with Shopify's Admin API for store data,
 * products, orders, customers, and more.
 */

/**
 * Calls Shopify's Admin GraphQL API
 */
export async function callShopifyGraphQL(query: string, variables = {}) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopToken = process.env.SHOPIFY_ADMIN_TOKEN;
  
  if (!shopDomain || !shopToken) {
    throw new Error("Missing Shopify API credentials. Check your .env file.");
  }

  const url = `https://${shopDomain}/admin/api/2025-01/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": shopToken
    },
    body: JSON.stringify({ query, variables })
  });

  const result = await response.json();
  
  // Add the GraphQL query, variables, and raw response to the result for debugging
  result._graphql = {
    query,
    variables,
    response: {
      data: result.data,
      errors: result.errors
    }
  };
  
  return result;
}

/**
 * Fetches orders from Shopify with optional filters
 */
export async function fetchOrdersFromShopify({ status, since }: { status?: string; since?: string }) {
  // Build a GraphQL query with filters if provided
  let queryFilter = "";
  if (status) queryFilter += `fulfillment_status:${status}`;
  if (since) queryFilter += (queryFilter ? " AND " : "") + `updated_at:>=${since}`;
  
  const gql = `#graphql
    query ($query: String) {
      orders(first: 5, query: $query) {
        edges {
          node {
            id
            name
            financialStatus
            fulfillmentStatus
            createdAt
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            customer {
              firstName
              lastName
              email
            }
          }
        }
      }
    }
  `;
  
  const variables = { query: queryFilter || undefined };
  const result = await callShopifyGraphQL(gql, variables);
  
  if (result.errors) {
    return { error: result.errors[0].message || "Error fetching orders" };
  }
  
  // Extract order info
  const orders = result.data.orders.edges.map((edge: any) => edge.node);
  return { 
    orders,
    _graphql: result._graphql 
  };
}

/**
 * Updates inventory for a product variant
 */
export async function updateInventoryInShopify({ 
  variant_id, 
  new_quantity, 
  location_id 
}: { 
  variant_id: string; 
  new_quantity: number; 
  location_id: string;
}) {
  const gql = `#graphql
    mutation adjustInventory($inventoryItemId: ID!, $locationId: ID!, $adjustment: Int!) {
      inventoryAdjustQuantity(input: {
        inventoryItemId: $inventoryItemId,
        availableDelta: $adjustment,
        locationId: $locationId
      }) {
        inventoryLevel {
          available
        }
        userErrors {
          message
        }
      }
    }
  `;
  
  const variables = {
    inventoryItemId: variant_id,
    locationId: location_id,
    adjustment: new_quantity
  };
  
  const result = await callShopifyGraphQL(gql, variables);
  const data = result.data?.inventoryAdjustQuantity;
  
  if (!data || data.userErrors.length) {
    return { error: data?.userErrors[0]?.message || "Inventory update failed" };
  }
  
  return { 
    success: true, 
    newAvailable: data.inventoryLevel.available,
    _graphql: result._graphql 
  };
}

/**
 * Finds a customer by email
 */
export async function fetchCustomerByEmail({ email }: { email: string }) {
  const gql = `#graphql
    query ($query: String) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            orders(first: 3) {
              edges { 
                node { 
                  id 
                  name
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  createdAt 
                } 
              }
            }
          }
        }
      }
    }
  `;
  
  const variables = { query: `email:${email}` };
  const result = await callShopifyGraphQL(gql, variables);
  
  if (result.errors) {
    return { error: result.errors[0].message || "Error finding customer" };
  }
  
  if (result.data.customers.edges.length === 0) {
    return { error: "No customer found with that email." };
  }
  
  const customer = result.data.customers.edges[0].node;
  return { 
    customer,
    _graphql: result._graphql 
  };
}

/**
 * Fetches basic store information from Shopify
 */
export async function fetchStoreInformation() {
  const gql = `#graphql
    query {
      shop {
        name
        email
        myshopifyDomain
        plan {
          displayName
        }
        primaryDomain {
          url
        }
        billingAddress {
          formatted
        }
      }
    }
  `;
  
  const result = await callShopifyGraphQL(gql);
  
  if (result.errors) {
    return { error: result.errors[0].message || "Error fetching store information" };
  }
  
  return { 
    shop: result.data.shop,
    _graphql: result._graphql 
  };
}

/**
 * Searches for products by title, SKU, or product type
 */
export async function searchProducts({ query }: { query: string }) {
  const gql = `#graphql
    query ($query: String!) {
      products(first: 5, query: $query) {
        edges {
          node {
            id
            title
            handle
            productType
            vendor
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;
  
  const variables = { query };
  const result = await callShopifyGraphQL(gql, variables);
  
  if (result.errors) {
    return { error: result.errors[0].message || "Error searching products" };
  }
  
  if (result.data.products.edges.length === 0) {
    return { error: "No products found matching the search criteria." };
  }
  
  const products = result.data.products.edges.map((edge: any) => {
    const product = edge.node;
    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      productType: product.productType,
      vendor: product.vendor,
      variants: product.variants.edges.map((variantEdge: any) => {
        const variant = variantEdge.node;
        return {
          id: variant.id,
          title: variant.title,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity
        };
      })
    };
  });
  
  return { 
    products,
    _graphql: result._graphql 
  };
}

/**
 * Execute arbitrary GraphQL query against Shopify Admin API
 */
export async function executeShopifyQuery(
  { query, variables = {} }: { query: string; variables?: any }
) {
  try {
    const result = await callShopifyGraphQL(query, variables);
    
    if (result.errors) {
      return { 
        error: result.errors[0].message || "Error executing GraphQL query",
        _graphql: result._graphql
      };
    }
    
    return { 
      data: result.data,
      _graphql: result._graphql
    };
  } catch (error: any) {
    return { 
      error: error.message || "Error executing GraphQL query"
    };
  }
}

/**
 * Execute arbitrary GraphQL mutation against Shopify Admin API
 */
export async function executeShopifyMutation(
  { mutation, variables = {} }: { mutation: string; variables?: any }
) {
  try {
    const result = await callShopifyGraphQL(mutation, variables);
    
    if (result.errors) {
      return { 
        error: result.errors[0].message || "Error executing GraphQL mutation",
        _graphql: result._graphql
      };
    }
    
    return { 
      data: result.data,
      _graphql: result._graphql
    };
  } catch (error: any) {
    return { 
      error: error.message || "Error executing GraphQL mutation"
    };
  }
}