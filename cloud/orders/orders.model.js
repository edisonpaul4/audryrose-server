exports.OrdersModel = new class OrdersModel {
  constructor() {
    this.Orders = Parse.Object.extend('Order');
  }

  /**
   * @returns Promise - Array of objects
   * @param { includes: Array<String> , contained: Array<Object> , notContained: Array<Object> , equal: Array<Object> , notEqual: Array<Object> , exists: Array<String>, notExists: Array<String>, greaterOrEqual: Array<Object>, lessOrEqual: Array<Object>, limit: Number, skip: Number , count: Boolean }
   */
  getOrdersByFilters(params) {
    var ordersQuery = new Parse.Query(this.Orders);

    if (params.includes !== null && typeof params.includes !== 'undefined')
      params.includes.map(include => ordersQuery.include(include));
      
    if (params.contained !== null && typeof params.contained !== 'undefined')
      params.contained.map(param => ordersQuery.containedIn(param.key, param.value));

    if (params.notContained !== null && typeof params.notContained !== 'undefined')
      params.notContained.map(param => ordersQuery.notContainedIn(param.key, param.value));

    if (params.equal !== null && typeof params.equal !== 'undefined')
      params.equal.map(condition => ordersQuery.equalTo(condition.key, condition.value));

    if (params.notEqual !== null && typeof params.notEqual !== 'undefined')
      params.notEqual.map(condition => ordersQuery.notEqualTo(condition.key, condition.value));

    if (params.exists !== null && typeof params.exists !== 'undefined')
      params.exists.map(key => ordersQuery.exists(key));

    if (params.notExists !== null && typeof params.notExists !== 'undefined')
      params.notExists.map(key => ordersQuery.doesNotExist(key));

    if (params.greaterOrEqual !== null && typeof params.greaterOrEqual !== 'undefined')
      params.greaterOrEqual.map(condition => ordersQuery.greaterThanOrEqualTo(condition.key, condition.value));

    if (params.lessOrEqual !== null && typeof params.lessOrEqual !== 'undefined')
      params.lessOrEqual.map(condition => ordersQuery.lessThanOrEqualTo(condition.key, condition.value));

    if (params.limit === null || typeof params.limit === 'undefined')
      params.limit = 100;

    if (params.skip === null || typeof params.skip === 'undefined')
      params.skip = 0;

    ordersQuery
      .limit(params.limit)
      .skip(params.skip)
      
    if (params.count !== null && typeof params.count !== 'undefined' && params.count)
      return ordersQuery
        .count();
    else if (params.json !== null && typeof params.json !== 'undefined' && params.json)
      return ordersQuery
        .find()
        .then(objects => objects.map(object => object.toJSON()));
    else
      return ordersQuery
        .find();
  } // END getOrdersByFilters
}