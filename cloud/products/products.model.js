exports.ProductsModel = new class ProductsModel {
  constructor(){
    this.Products = Parse.Object.extend('Product');
  }

  /**
   * @returns Promise - Array of objects
   * @param {*} param0
   */
  getProductsByFilters(params) {
    var productsQuery = new Parse.Query(this.Products);
    
    if (params.includes !== null && typeof params.includes !== 'undefined')
      params.includes.map(include => productsQuery.include(include));

    if (params.equal !== null && typeof params.equal !== 'undefined')
      params.equal.map(condition => productsQuery.equalTo(condition.key, condition.value))
      
    if (params.notEqual !== null && typeof params.notEqual !== 'undefined')
      params.notEqual.map(condition => productsQuery.notEqualTo(condition.key, condition.value))
      
    if (params.exists !== null && typeof params.exists !== 'undefined')
      params.exists.map(key => productsQuery.exists(key))

    if (params.notExists !== null && typeof params.notExists !== 'undefined')
      params.notExists.map(key => productsQuery.doesNotExist(key))

    if (params.limit === null || typeof params.limit === 'undefined' )
      params.limit = 100;

    if (params.skip === null || typeof params.skip === 'undefined' )
      params.skip = 0;

    productsQuery
      .limit(params.limit)
      .skip(params.skip)

    if (params.count !== null && typeof params.count !== 'undefined' && params.count)
      return productsQuery
        .count();
    else if (params.json !== null && typeof params.json !== 'undefined' && params.json)
      return productsQuery
        .find()
        .then(objects => objects.map(object => object.toJSON()));
    else
      return productsQuery;
  }  
}