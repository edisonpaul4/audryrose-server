exports.BaseModel = class BaseModel {
  constructor(){}

  /**
   * @returns Promise - Array of objects
   * @param { includes: Array<String> , contained: Array<Object> , notContained: Array<Object> , equal: Array<Object> , notEqual: Array<Object> , exists: Array<String>, notExists: Array<String>, greaterOrEqual: Array<Object>, lessOrEqual: Array<Object>, limit: Number, skip: Number , count: Boolean }
   * @param Parser query object
   */
  searchDatabase(params, query) {

    if (params.includes !== null && typeof params.includes !== 'undefined')
      params.includes.map(include => query.include(include));

    if (params.contained !== null && typeof params.contained !== 'undefined')
      params.contained.map(param => query.containedIn(param.key, param.value));

    if (params.notContained !== null && typeof params.notContained !== 'undefined')
      params.notContained.map(param => query.notContainedIn(param.key, param.value));

    if (params.equal !== null && typeof params.equal !== 'undefined')
      params.equal.map(condition => query.equalTo(condition.key, condition.value));

    if (params.notEqual !== null && typeof params.notEqual !== 'undefined')
      params.notEqual.map(condition => query.notEqualTo(condition.key, condition.value));

    if (params.exists !== null && typeof params.exists !== 'undefined')
      params.exists.map(key => query.exists(key));

    if (params.notExists !== null && typeof params.notExists !== 'undefined')
      params.notExists.map(key => query.doesNotExist(key));

    if (params.greaterOrEqual !== null && typeof params.greaterOrEqual !== 'undefined')
      params.greaterOrEqual.map(condition => query.greaterThanOrEqualTo(condition.key, condition.value));

    if (params.lessOrEqual !== null && typeof params.lessOrEqual !== 'undefined')
      params.lessOrEqual.map(condition => query.lessThanOrEqualTo(condition.key, condition.value));

    if (params.limit === null || typeof params.limit === 'undefined')
      params.limit = 100;

    if (params.skip === null || typeof params.skip === 'undefined')
      params.skip = 0;

    query
      .limit(params.limit)
      .skip(params.skip)

    if (params.count !== null && typeof params.count !== 'undefined' && params.count)
      return query
        .count();
    else if (params.json !== null && typeof params.json !== 'undefined' && params.json)
      return query
        .find()
        .then(objects => objects.map(object => object.toJSON()));
    else
      return query
  } // END getOrdersByFilters
}